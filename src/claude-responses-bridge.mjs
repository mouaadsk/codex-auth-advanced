import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { claudeGatewayModelWireApi } from "./claude-gateway.mjs";
import { isVsllmApiAccount } from "./provider-policy.mjs";

// The protocol shape and event-state approach are informed by CLIProxyAPI's
// MIT-licensed Claude-to-Codex translator, adapted here for this Node proxy.

function normalizedUrlPath(target) {
  try {
    return new URL(target?.url || "").pathname.replace(/\/$/, "");
  } catch {
    return "";
  }
}

function isClaudeMessagesPath(target) {
  return normalizedUrlPath(target).endsWith("/messages");
}

function isClaudeCountTokensPath(target) {
  return normalizedUrlPath(target).endsWith("/messages/count_tokens");
}

function responsesTargetFromClaudeTarget(target) {
  const url = new URL(target.url);
  url.pathname = url.pathname
    .replace(/\/messages\/count_tokens\/?$/, "/responses")
    .replace(/\/messages\/?$/, "/responses");
  url.search = "";
  return {
    ...target,
    url: url.toString(),
    claudeResponsesBridge: true
  };
}

function parseBody(body) {
  if (!Buffer.isBuffer(body) || body.length === 0) return null;
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
}

function safeJsonStringify(value, fallback = "{}") {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return fallback;
  }
}

function normalizeToolParameters(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  const result = structuredClone(schema);
  if (!result.type) result.type = "object";
  if (result.type === "object" && (!result.properties || typeof result.properties !== "object")) {
    result.properties = {};
  }
  delete result.$schema;
  return result;
}

function shortenToolName(name) {
  const value = String(name || "");
  if (value.length <= 64) return value;
  if (value.startsWith("mcp__")) {
    const lastSeparator = value.lastIndexOf("__");
    if (lastSeparator > 0) return `mcp__${value.slice(lastSeparator + 2)}`.slice(0, 64);
  }
  return value.slice(0, 64);
}

function buildToolNameMaps(tools) {
  const originalToShort = new Map();
  const shortToOriginal = new Map();
  const used = new Set();
  for (const tool of Array.isArray(tools) ? tools : []) {
    const original = typeof tool?.name === "string" ? tool.name : "";
    if (!original) continue;
    const base = shortenToolName(original);
    let candidate = base;
    let suffix = 1;
    while (used.has(candidate)) {
      const ending = `_${suffix}`;
      candidate = `${base.slice(0, 64 - ending.length)}${ending}`;
      suffix += 1;
    }
    used.add(candidate);
    originalToShort.set(original, candidate);
    shortToOriginal.set(candidate, original);
  }
  return { originalToShort, shortToOriginal };
}

function shortenCallId(id) {
  const value = String(id || "");
  if (value.length <= 64) return value;
  const suffix = `_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
  return `${value.slice(0, 64 - suffix.length)}${suffix}`;
}

let generatedToolIdCounter = 0;

function sanitizeClaudeToolId(id) {
  const sanitized = String(id || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  if (sanitized) return shortenCallId(sanitized);
  generatedToolIdCounter += 1;
  return `toolu_${Date.now()}_${generatedToolIdCounter}`;
}

function imageContentPart(part) {
  const source = part?.source;
  if (!source || typeof source !== "object") return null;
  if (source.type === "url" && typeof source.url === "string") {
    return { type: "input_image", image_url: source.url };
  }
  const data = typeof source.data === "string" ? source.data : typeof source.base64 === "string" ? source.base64 : "";
  if (!data) return null;
  const mediaType = source.media_type || source.mime_type || "application/octet-stream";
  return { type: "input_image", image_url: `data:${mediaType};base64,${data}` };
}

function documentContentPart(part) {
  const source = part?.source;
  if (!source || typeof source !== "object") return null;
  const data = typeof source.data === "string" ? source.data : typeof source.base64 === "string" ? source.base64 : "";
  if (!data) return null;
  const mediaType = source.media_type || source.mime_type || "application/pdf";
  return {
    type: "input_file",
    filename: part.title || source.filename || "document",
    file_data: `data:${mediaType};base64,${data}`
  };
}

function responseMessagePart(part, role) {
  if (!part || typeof part !== "object") return null;
  if (part.type === "text" && typeof part.text === "string") {
    return { type: role === "assistant" ? "output_text" : "input_text", text: part.text };
  }
  if (role !== "assistant" && part.type === "image") return imageContentPart(part);
  if (role !== "assistant" && part.type === "document") return documentContentPart(part);
  return null;
}

function toolResultOutput(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return safeJsonStringify(content, "");
  const parts = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") {
      parts.push({ type: "input_text", text: part.text });
    } else if (part?.type === "image") {
      const image = imageContentPart(part);
      if (image) parts.push(image);
    } else if (part?.type === "document") {
      const document = documentContentPart(part);
      if (document) parts.push(document);
    }
  }
  return parts.length > 0 ? parts : safeJsonStringify(content, "");
}

function budgetToReasoningEffort(budget) {
  const value = Number(budget);
  if (!Number.isFinite(value) || value < -1) return null;
  if (value === -1) return "auto";
  if (value === 0) return "none";
  if (value <= 512) return "minimal";
  if (value <= 1024) return "low";
  if (value <= 8192) return "medium";
  if (value <= 24576) return "high";
  return "xhigh";
}

function claudeReasoningEffort(payload) {
  const thinking = payload?.thinking;
  if (thinking?.type === "disabled") return "none";
  if (thinking?.type === "enabled") {
    return budgetToReasoningEffort(thinking.budget_tokens) || "medium";
  }
  if (thinking?.type === "adaptive" || thinking?.type === "auto") {
    const configured = String(payload?.output_config?.effort || "").trim().toLowerCase();
    if (["max", "ultra"].includes(configured)) return "xhigh";
    return configured || "xhigh";
  }
  return "medium";
}

function translatedToolChoice(toolChoice, nameMap, webSearchNames) {
  if (!toolChoice) return "auto";
  const type = typeof toolChoice === "string" ? toolChoice : toolChoice.type;
  if (type === "any") return "required";
  if (type === "none") return "none";
  if (type !== "tool") return "auto";
  const originalName = String(toolChoice.name || "");
  if (webSearchNames.has(originalName)) return { type: "web_search" };
  const name = nameMap.get(originalName) || shortenToolName(originalName);
  return name ? { type: "function", name } : "auto";
}

function isClaudeWebSearchTool(tool) {
  return ["web_search_20250305", "web_search_20260209"].includes(String(tool?.type || ""));
}

export function translateClaudeMessagesRequestToResponses(payload) {
  const model = String(payload?.model || "").trim();
  const { originalToShort } = buildToolNameMaps(payload?.tools);
  const input = [];

  const systemParts = [];
  if (typeof payload?.system === "string" && payload.system) {
    systemParts.push({ type: "input_text", text: payload.system });
  } else if (Array.isArray(payload?.system)) {
    for (const part of payload.system) {
      if (part?.type === "text" && typeof part.text === "string" && part.text) {
        systemParts.push({ type: "input_text", text: part.text });
      }
    }
  }
  if (systemParts.length > 0) input.push({ type: "message", role: "developer", content: systemParts });

  for (const message of Array.isArray(payload?.messages) ? payload.messages : []) {
    const role = message?.role === "assistant" ? "assistant" : message?.role === "system" ? "developer" : "user";
    if (typeof message?.content === "string") {
      input.push({
        type: "message",
        role,
        content: [{ type: role === "assistant" ? "output_text" : "input_text", text: message.content }]
      });
      continue;
    }
    if (!Array.isArray(message?.content)) continue;

    let messageParts = [];
    const flushMessage = () => {
      if (messageParts.length === 0) return;
      input.push({ type: "message", role, content: messageParts });
      messageParts = [];
    };

    for (const part of message.content) {
      const messagePart = responseMessagePart(part, role);
      if (messagePart) {
        messageParts.push(messagePart);
        continue;
      }
      if (part?.type === "thinking" && role === "assistant") {
        const signature = typeof part.signature === "string" ? part.signature : "";
        if (signature) {
          flushMessage();
          input.push({ type: "reasoning", summary: [], content: null, encrypted_content: signature });
        }
        continue;
      }
      if (part?.type === "tool_use" && role === "assistant") {
        flushMessage();
        const originalName = String(part.name || "");
        input.push({
          type: "function_call",
          call_id: shortenCallId(part.id),
          name: originalToShort.get(originalName) || shortenToolName(originalName),
          arguments: safeJsonStringify(part.input)
        });
        continue;
      }
      if (part?.type === "tool_result") {
        flushMessage();
        input.push({
          type: "function_call_output",
          call_id: shortenCallId(part.tool_use_id),
          output: toolResultOutput(part.content)
        });
      }
    }
    flushMessage();
  }

  const tools = [];
  const webSearchNames = new Set();
  for (const tool of Array.isArray(payload?.tools) ? payload.tools : []) {
    if (isClaudeWebSearchTool(tool)) {
      if (tool.name) webSearchNames.add(tool.name);
      const webSearch = { type: "web_search" };
      if (Array.isArray(tool.allowed_domains)) webSearch.filters = { allowed_domains: tool.allowed_domains };
      if (tool.user_location && typeof tool.user_location === "object") webSearch.user_location = tool.user_location;
      tools.push(webSearch);
      continue;
    }
    const originalName = String(tool?.name || "");
    if (!originalName) continue;
    tools.push({
      type: "function",
      name: originalToShort.get(originalName) || shortenToolName(originalName),
      description: typeof tool.description === "string" ? tool.description : "",
      parameters: normalizeToolParameters(tool.input_schema),
      strict: false
    });
  }

  const translated = {
    model,
    instructions: "",
    input,
    parallel_tool_calls: payload?.tool_choice?.disable_parallel_tool_use !== true,
    reasoning: {
      effort: claudeReasoningEffort(payload),
      summary: "auto"
    },
    stream: payload?.stream !== false,
    store: false,
    include: ["reasoning.encrypted_content"]
  };
  if (tools.length > 0) {
    translated.tools = tools;
    translated.tool_choice = translatedToolChoice(payload.tool_choice, originalToShort, webSearchNames);
  }
  const serviceTier = String(payload?.service_tier || "").trim().toLowerCase();
  if (["fast", "priority"].includes(serviceTier) || payload?.speed === "fast") {
    translated.service_tier = "priority";
  }
  return translated;
}

function binaryAwareJsonSize(value) {
  let binaryParts = 0;
  const json = JSON.stringify(value, (key, child) => {
    if (["data", "base64"].includes(key) && typeof child === "string" && child.length > 256) {
      binaryParts += 1;
      return `[binary:${child.length}]`;
    }
    return child;
  });
  return { bytes: Buffer.byteLength(json || "", "utf8"), binaryParts };
}

export function estimateClaudeInputTokens(payload) {
  const { bytes, binaryParts } = binaryAwareJsonSize(payload);
  const messageOverhead = (Array.isArray(payload?.messages) ? payload.messages.length : 0) * 12;
  const toolOverhead = (Array.isArray(payload?.tools) ? payload.tools.length : 0) * 32;
  return Math.max(1, Math.ceil(bytes / 3) + messageOverhead + toolOverhead + binaryParts * 1600);
}

export function prepareClaudeResponsesBridge(target, body) {
  if (!isVsllmApiAccount(target?.account, target?.upstreamBaseUrl || target?.url || "")) return null;
  if (!isClaudeMessagesPath(target) && !isClaudeCountTokensPath(target)) return null;
  const originalRequest = parseBody(body);
  if (!originalRequest || claudeGatewayModelWireApi(originalRequest.model) !== "responses") return null;
  if (isClaudeCountTokensPath(target)) {
    return {
      kind: "count_tokens",
      inputTokens: estimateClaudeInputTokens(originalRequest),
      originalRequest
    };
  }
  const translatedRequest = translateClaudeMessagesRequestToResponses(originalRequest);
  return {
    kind: "responses",
    target: responsesTargetFromClaudeTarget(target),
    body: Buffer.from(JSON.stringify(translatedRequest), "utf8"),
    originalRequest,
    translatedRequest,
    stream: translatedRequest.stream === true
  };
}

export function retargetClaudeResponsesBridge(target, bridge) {
  if (bridge?.kind !== "responses") return target;
  return responsesTargetFromClaudeTarget(target);
}

function sseEvent(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function responseUsage(usage) {
  const cachedTokens = Number(usage?.input_tokens_details?.cached_tokens) || 0;
  const totalInput = Number(usage?.input_tokens) || 0;
  const result = {
    input_tokens: Math.max(0, totalInput - cachedTokens),
    output_tokens: Number(usage?.output_tokens) || 0
  };
  if (cachedTokens > 0) result.cache_read_input_tokens = cachedTokens;
  return result;
}

function responseStopReason(response, hasToolUse) {
  if (hasToolUse) return "tool_use";
  const reason = response?.stop_reason || response?.incomplete_details?.reason || "";
  if (["max_tokens", "max_output_tokens"].includes(reason)) return "max_tokens";
  if (reason === "content_filter") return "refusal";
  if (["stop_sequence", "pause_turn", "refusal", "model_context_window_exceeded"].includes(reason)) return reason;
  return "end_turn";
}

function responseStopSequence(response) {
  return typeof response?.stop_sequence === "string" && response.stop_sequence ? response.stop_sequence : null;
}

function reasoningText(item) {
  if (typeof item?.summary === "string") return item.summary;
  if (item?.summary && !Array.isArray(item.summary) && typeof item.summary?.text === "string") return item.summary.text;
  if (typeof item?.content === "string") return item.content;
  const parts = Array.isArray(item?.summary) ? item.summary : Array.isArray(item?.content) ? item.content : [];
  return parts.map((part) => typeof part === "string" ? part : String(part?.text || "")).join("");
}

class ClaudeResponsesStreamState {
  constructor(originalRequest) {
    this.originalRequest = originalRequest || {};
    this.model = String(originalRequest?.model || "");
    this.toolNames = buildToolNameMaps(originalRequest?.tools).shortToOriginal;
    this.messageStarted = false;
    this.terminal = false;
    this.blockIndex = 0;
    this.textOpen = false;
    this.thinkingOpen = false;
    this.thinkingSignature = "";
    this.thinkingSummarySeen = false;
    this.hasReasoningOutput = false;
    this.reasoningTextSeen = false;
    this.hasToolUse = false;
    this.hasTextDelta = false;
    this.textItemIds = new Set();
    this.reasoningItemIds = new Set();
    this.calls = new Map();
  }

  ensureMessageStart(response = {}) {
    if (this.messageStarted) return "";
    this.messageStarted = true;
    this.model = response.model || this.model;
    return sseEvent("message_start", {
      type: "message_start",
      message: {
        id: response.id || `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  }

  startText() {
    if (this.textOpen) return "";
    this.textOpen = true;
    return sseEvent("content_block_start", {
      type: "content_block_start",
      index: this.blockIndex,
      content_block: { type: "text", text: "" }
    });
  }

  stopText() {
    if (!this.textOpen) return "";
    const index = this.blockIndex;
    this.textOpen = false;
    this.blockIndex += 1;
    return sseEvent("content_block_stop", { type: "content_block_stop", index });
  }

  startThinking() {
    if (this.thinkingOpen) return "";
    this.thinkingOpen = true;
    this.thinkingSummarySeen = true;
    return sseEvent("content_block_start", {
      type: "content_block_start",
      index: this.blockIndex,
      content_block: { type: "thinking", thinking: "" }
    });
  }

  stopThinking() {
    if (!this.thinkingOpen) return "";
    let output = "";
    if (this.thinkingSignature) {
      output += sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: this.blockIndex,
        delta: { type: "signature_delta", signature: this.thinkingSignature }
      });
    }
    output += sseEvent("content_block_stop", { type: "content_block_stop", index: this.blockIndex });
    this.thinkingOpen = false;
    this.thinkingSignature = "";
    this.thinkingSummarySeen = false;
    this.blockIndex += 1;
    return output;
  }

  callKeys(event, item = {}) {
    const keys = [];
    if (event?.output_index !== undefined) keys.push(`output:${event.output_index}`);
    if (item?.id) keys.push(`item:${item.id}`);
    if (event?.item_id) keys.push(`item:${event.item_id}`);
    if (item?.call_id) keys.push(`call:${item.call_id}`);
    return keys;
  }

  findCall(event, item = {}) {
    for (const key of this.callKeys(event, item)) {
      const call = this.calls.get(key);
      if (call) return call;
    }
    return null;
  }

  registerCall(event, item = {}) {
    let call = this.findCall(event, item);
    if (!call) {
      call = {
        callId: String(item.call_id || ""),
        name: String(item.name || ""),
        arguments: "",
        receivedDelta: false,
        open: false,
        done: false,
        blockIndex: null
      };
    }
    if (item.call_id) call.callId = String(item.call_id);
    if (item.name) call.name = String(item.name);
    for (const key of this.callKeys(event, item)) this.calls.set(key, call);
    return call;
  }

  startCall(call) {
    if (call.open || call.done || !call.name) return "";
    call.open = true;
    call.blockIndex = this.blockIndex;
    this.hasToolUse = true;
    const name = this.toolNames.get(call.name) || call.name;
    return sseEvent("content_block_start", {
      type: "content_block_start",
      index: call.blockIndex,
      content_block: {
        type: "tool_use",
        id: sanitizeClaudeToolId(call.callId),
        name,
        input: {}
      }
    }) + sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: call.blockIndex,
      delta: { type: "input_json_delta", partial_json: "" }
    });
  }

  stopCall(call) {
    if (!call.open || call.done) return "";
    call.open = false;
    call.done = true;
    if (this.blockIndex <= call.blockIndex) this.blockIndex = call.blockIndex + 1;
    return sseEvent("content_block_stop", { type: "content_block_stop", index: call.blockIndex });
  }

  functionDelta(call, delta) {
    if (!call.open) return "";
    call.receivedDelta = true;
    call.arguments += delta;
    return sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: call.blockIndex,
      delta: { type: "input_json_delta", partial_json: delta }
    });
  }

  completeCall(event, item) {
    const call = this.registerCall(event, item);
    let output = "";
    output += this.stopThinking();
    output += this.stopText();
    output += this.startCall(call);
    const argumentsText = typeof item?.arguments === "string" && item.arguments ? item.arguments : call.arguments;
    if (!call.receivedDelta && argumentsText) output += this.functionDelta(call, argumentsText);
    output += this.stopCall(call);
    return output;
  }

  terminalFallback(response) {
    let output = "";
    for (const item of Array.isArray(response?.output) ? response.output : []) {
      if (item?.type === "function_call") {
        const call = this.registerCall({}, item);
        if (!call.done) output += this.completeCall({}, item);
      } else if (item?.type === "message") {
        const itemId = String(item.id || "terminal");
        if (this.hasTextDelta || this.textItemIds.has(itemId)) continue;
        const text = (Array.isArray(item.content) ? item.content : [])
          .filter((part) => part?.type === "output_text")
          .map((part) => String(part.text || ""))
          .join("");
        if (text) {
          output += this.stopThinking();
          output += this.startText();
          output += sseEvent("content_block_delta", {
            type: "content_block_delta",
            index: this.blockIndex,
            delta: { type: "text_delta", text }
          });
          output += this.stopText();
          this.textItemIds.add(itemId);
        }
      } else if (item?.type === "reasoning"
        && !this.hasReasoningOutput
        && !this.reasoningItemIds.has(String(item.id || ""))
        && !this.thinkingSummarySeen) {
        const text = reasoningText(item);
        this.thinkingSignature = String(item.encrypted_content || this.thinkingSignature || "");
        if (text || this.thinkingSignature) {
          output += this.startThinking();
          if (text) {
            output += sseEvent("content_block_delta", {
              type: "content_block_delta",
              index: this.blockIndex,
              delta: { type: "thinking_delta", thinking: text }
            });
          }
          output += this.stopThinking();
        }
      }
    }
    return output;
  }

  terminalResponse(response) {
    if (this.terminal) return "";
    this.terminal = true;
    let output = this.ensureMessageStart(response);
    output += this.terminalFallback(response);
    output += this.stopThinking();
    output += this.stopText();
    for (const call of new Set(this.calls.values())) output += this.stopCall(call);
    output += sseEvent("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: responseStopReason(response, this.hasToolUse),
        stop_sequence: responseStopSequence(response)
      },
      usage: responseUsage(response?.usage)
    });
    output += sseEvent("message_stop", { type: "message_stop" });
    return output;
  }

  errorEvent(event) {
    this.terminal = true;
    const error = event?.error || event?.response?.error || event || {};
    return sseEvent("error", {
      type: "error",
      error: {
        type: error.type === "invalid_request" ? "invalid_request_error" : error.type || "api_error",
        message: error.message || error.code || "The upstream Responses request failed."
      }
    });
  }

  translate(event) {
    const type = String(event?.type || "");
    if (!type) return "";
    if (type === "error" || type === "response.failed") return this.errorEvent(event);
    if (type === "response.created") return this.ensureMessageStart(event.response || {});
    if (["response.completed", "response.incomplete"].includes(type)) return this.terminalResponse(event.response || {});

    let output = this.ensureMessageStart(event.response || {});
    if (type === "response.reasoning_summary_part.added") {
      this.hasReasoningOutput = true;
      output += this.stopThinking();
      output += this.startThinking();
    } else if (type === "response.reasoning_summary_text.delta") {
      this.hasReasoningOutput = true;
      this.reasoningTextSeen = true;
      output += this.startThinking();
      output += sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: this.blockIndex,
        delta: { type: "thinking_delta", thinking: String(event.delta || "") }
      });
    } else if (type === "response.content_part.added" && event.part?.type === "output_text") {
      output += this.stopThinking();
      output += this.startText();
    } else if (["response.output_text.delta", "response.refusal.delta"].includes(type)) {
      output += this.stopThinking();
      output += this.startText();
      this.hasTextDelta = true;
      if (event.item_id) this.textItemIds.add(String(event.item_id));
      output += sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: this.blockIndex,
        delta: { type: "text_delta", text: String(event.delta || "") }
      });
    } else if (type === "response.content_part.done" && event.part?.type === "output_text") {
      output += this.stopText();
    } else if (type === "response.output_item.added") {
      if (event.item?.type === "reasoning") {
        this.thinkingSignature = String(event.item.encrypted_content || "");
      } else if (event.item?.type === "function_call") {
        output += this.stopThinking();
        output += this.stopText();
        const call = this.registerCall(event, event.item);
        output += this.startCall(call);
      }
    } else if (type === "response.function_call_arguments.delta") {
      const call = this.findCall(event) || this.registerCall(event, {});
      const delta = String(event.delta || "");
      if (call.open) output += this.functionDelta(call, delta);
      else call.arguments += delta;
    } else if (type === "response.function_call_arguments.done") {
      const call = this.findCall(event) || this.registerCall(event, {});
      if (!call.receivedDelta && !call.arguments && typeof event.arguments === "string") {
        call.arguments = event.arguments;
        if (call.open) output += this.functionDelta(call, event.arguments);
      }
    } else if (type === "response.output_item.done") {
      const item = event.item || {};
      if (item.type === "function_call") {
        output += this.completeCall(event, item);
      } else if (item.type === "reasoning") {
        this.hasReasoningOutput = true;
        if (item.id) this.reasoningItemIds.add(String(item.id));
        this.thinkingSignature = String(item.encrypted_content || this.thinkingSignature || "");
        if (!this.thinkingSummarySeen && !this.reasoningTextSeen) {
          const text = reasoningText(item);
          if (text || this.thinkingSignature) {
            output += this.startThinking();
            if (text) {
              output += sseEvent("content_block_delta", {
                type: "content_block_delta",
                index: this.blockIndex,
                delta: { type: "thinking_delta", thinking: text }
              });
            }
          }
        }
        output += this.stopThinking();
      } else if (item.type === "message") {
        const itemId = String(item.id || `output:${event.output_index ?? "message"}`);
        if (!this.hasTextDelta && !this.textItemIds.has(itemId)) {
          const text = (Array.isArray(item.content) ? item.content : [])
            .filter((part) => part?.type === "output_text")
            .map((part) => String(part.text || ""))
            .join("");
          if (text) {
            output += this.stopThinking();
            output += this.startText();
            output += sseEvent("content_block_delta", {
              type: "content_block_delta",
              index: this.blockIndex,
              delta: { type: "text_delta", text }
            });
            output += this.stopText();
          }
          this.textItemIds.add(itemId);
        }
      }
    }
    return output;
  }
}

function nextSseBoundary(buffer) {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf < 0) return crlf < 0 ? null : { index: crlf, length: 4 };
  if (crlf < 0 || lf < crlf) return { index: lf, length: 2 };
  return { index: crlf, length: 4 };
}

function parseSseData(frame) {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function createClaudeResponsesSseTransformStream(originalRequest, diagnostics = null) {
  const state = new ClaudeResponsesStreamState(originalRequest);
  const decoder = new TextDecoder();
  let buffer = "";

  const consume = (flush = false) => {
    let output = "";
    while (true) {
      const boundary = nextSseBoundary(buffer);
      if (!boundary) break;
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const event = parseSseData(frame);
      if (!event) continue;
      diagnostics?.mark(event);
      output += state.translate(event);
    }
    if (flush && buffer.trim()) {
      const event = parseSseData(buffer);
      if (event) {
        diagnostics?.mark(event);
        output += state.translate(event);
      }
      buffer = "";
    }
    return output;
  };

  return new Transform({
    transform(chunk, encoding, callback) {
      try {
        buffer += decoder.decode(chunk, { stream: true });
        callback(null, consume(false));
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      try {
        buffer += decoder.decode();
        let output = consume(true);
        if (!state.terminal) {
          output += state.errorEvent({
            type: "api_error",
            message: "The upstream Responses stream ended before response.completed."
          });
        }
        callback(null, output);
      } catch (error) {
        callback(error);
      }
    }
  });
}

function responseObject(payload) {
  if (payload?.type === "response.completed" || payload?.type === "response.incomplete") return payload.response;
  if (payload?.object === "response" || (payload?.id && Array.isArray(payload?.output))) return payload;
  return null;
}

export function translateResponsesResponseToClaude(payload, originalRequest = {}) {
  const response = responseObject(payload);
  if (!response) return null;
  const toolNames = buildToolNameMaps(originalRequest?.tools).shortToOriginal;
  const content = [];
  let hasToolUse = false;
  for (const item of Array.isArray(response.output) ? response.output : []) {
    if (item?.type === "reasoning") {
      const thinking = reasoningText(item);
      const signature = String(item.encrypted_content || "");
      if (thinking || signature) {
        const block = { type: "thinking", thinking };
        if (signature) block.signature = signature;
        content.push(block);
      }
    } else if (item?.type === "message") {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part?.type === "output_text" && part.text) content.push({ type: "text", text: String(part.text) });
      }
    } else if (item?.type === "function_call") {
      let input = {};
      try {
        const parsed = JSON.parse(item.arguments || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed;
      } catch {
        input = {};
      }
      hasToolUse = true;
      content.push({
        type: "tool_use",
        id: sanitizeClaudeToolId(item.call_id),
        name: toolNames.get(item.name) || item.name,
        input
      });
    }
  }
  return {
    id: response.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: response.model || originalRequest.model || "",
    content,
    stop_reason: responseStopReason(response, hasToolUse),
    stop_sequence: responseStopSequence(response),
    usage: responseUsage(response.usage)
  };
}
