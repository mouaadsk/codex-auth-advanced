// Chat Completions <-> OpenAI Responses bridge.
//
// CLIProxyAPI's MIT-licensed translator informs the wire-shape choices here:
// Chat Completions is a thin wrapper around the same Responses-shaped data
// (messages, tools, tool_choice, reasoning_effort, stream). The interesting
// differences are message content parts (string vs [{type:"text",text}...}])
// and the response object (Chat returns {choices,usage}; Responses returns
// {output,usage}). Tool-call id casing and parallel-tool-call flags differ
// too.
//
// The bridge is intentionally one-direction per call site (request or
// response) and stateless; streaming is rebuilt on the response side by a
// Transform that produces Responses-style SSE events out of Chat-style SSE.

import { Transform } from "node:stream";

const RESPONSES_INPUT_LIMIT = 64;
const TOOL_NAME_LIMIT = 64;
const CALL_ID_LIMIT = 64;

function normalizedUrlPath(target) {
  try {
    return new URL(target?.url || "").pathname.replace(/\/$/, "");
  } catch {
    return "";
  }
}

function isResponsesPath(target) {
  return normalizedUrlPath(target).endsWith("/responses");
}

function isResponsesCompactPath(target) {
  return normalizedUrlPath(target).endsWith("/responses/compact");
}

function isChatCompletionsPath(target) {
  return normalizedUrlPath(target).endsWith("/chat/completions");
}

export function responsesTargetFromChatTarget(target) {
  const url = new URL(target.url);
  url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, "/responses");
  url.search = "";
  return {
    ...target,
    url: url.toString(),
    chatResponsesBridge: true
  };
}

export function chatTargetFromResponsesTarget(target) {
  const url = new URL(target.url);
  url.pathname = url.pathname.replace(/\/responses\/?$/, "/chat/completions");
  url.search = "";
  return {
    ...target,
    url: url.toString(),
    chatResponsesBridge: true
  };
}

function parseBody(body) {
  if (!body) return null;
  const raw = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
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

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeToolParameters(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const out = { ...schema };
  delete out.$schema;
  delete out.additionalProperties;
  if (out.type === undefined && out.properties === undefined) out.type = "object";
  if (out.type === "object" && out.properties === undefined) out.properties = {};
  if (out.type === "object" && out.required === undefined) out.required = [];
  return out;
}

function shortenToolName(name) {
  const original = String(name || "tool");
  if (original.length <= TOOL_NAME_LIMIT) return original;
  let hash = 0;
  for (let i = 0; i < original.length; i += 1) {
    hash = (hash * 31 + original.charCodeAt(i)) >>> 0;
  }
  const trimmed = original.slice(0, TOOL_NAME_LIMIT - 9);
  return `${trimmed}__${hash.toString(36)}`;
}

function buildToolNameMaps(tools) {
  const nameMap = new Map();
  const reverseMap = new Map();
  const toolsArray = asArray(tools);
  for (let i = 0; i < toolsArray.length; i += 1) {
    const tool = toolsArray[i];
    const original = String(tool?.function?.name || tool?.name || `tool_${i}`);
    const short = shortenToolName(original);
    nameMap.set(original, short);
    reverseMap.set(short, original);
  }
  return { nameMap, reverseMap };
}

function shortenCallId(id) {
  const original = String(id || "call");
  if (original.length <= CALL_ID_LIMIT) return original;
  let hash = 0;
  for (let i = 0; i < original.length; i += 1) {
    hash = (hash * 31 + original.charCodeAt(i)) >>> 0;
  }
  const trimmed = original.slice(0, CALL_ID_LIMIT - 9);
  return `${trimmed}__${hash.toString(36)}`;
}

function sanitizeChatToolCallId(id, knownShortIds) {
  const shortened = shortenCallId(id);
  if (!knownShortIds) return shortened;
  knownShortIds.add(shortened);
  return shortened;
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function imageContentPart(part) {
  const source = isPlainObject(part?.image_url) ? part.image_url : null;
  const url = source?.url || part?.url || "";
  if (!url) return null;
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;]+);base64,(.*)$/);
    if (match) {
      return {
        type: "input_image",
        image_url: `data:${match[1]};base64,${match[2]}`
      };
    }
    return { type: "input_image", image_url: url };
  }
  return { type: "input_image", image_url: url };
}

function documentContentPart(part) {
  if (typeof part?.file_data === "string" && part.file_data.startsWith("data:")) {
    const match = part.file_data.match(/^data:([^;]+);base64,(.*)$/);
    if (match) {
      return {
        type: "input_file",
        filename: part.filename || "document",
        file_data: part.file_data
      };
    }
  }
  if (typeof part?.file_id === "string") {
    return { type: "input_file", file_id: part.file_id };
  }
  return null;
}

function textContentPart(part) {
  if (typeof part === "string") return { type: "input_text", text: part };
  if (part?.type === "text" || part?.type === "input_text") {
    return { type: "input_text", text: String(part.text || "") };
  }
  if (part?.type === "output_text") {
    return { type: "input_text", text: String(part.text || "") };
  }
  return null;
}

function audioContentPart(part) {
  const inputAudio = part?.input_audio;
  if (inputAudio && typeof inputAudio.data === "string") {
    return {
      type: "input_audio",
      input_audio: {
        data: inputAudio.data,
        format: inputAudio.format || "wav"
      }
    };
  }
  return null;
}

function translateMessageContent(content) {
  if (content == null) return [];
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "image_url" || part.type === "image") {
      const image = imageContentPart(part);
      if (image) out.push(image);
      continue;
    }
    if (part.type === "input_file" || part.type === "file") {
      const doc = documentContentPart(part);
      if (doc) out.push(doc);
      continue;
    }
    if (part.type === "input_audio") {
      const audio = audioContentPart(part);
      if (audio) out.push(audio);
      continue;
    }
    if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
      const text = textContentPart(part);
      if (text) out.push(text);
      continue;
    }
    if (part.type === "refusal") {
      out.push({ type: "output_text", text: String(part.refusal || "") });
      continue;
    }
    const text = textContentPart(part);
    if (text) out.push(text);
  }
  return out;
}

function translateToolChoice(toolChoice, nameMap) {
  if (toolChoice == null || toolChoice === "auto") return "auto";
  if (toolChoice === "none" || toolChoice === "required") return toolChoice;
  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    const name = nameMap.get(toolChoice.function?.name) || toolChoice.function?.name;
    if (!name) return toolChoice;
    return { type: "function", function: { name } };
  }
  return toolChoice;
}

function translateTools(tools, nameMap) {
  const out = [];
  for (const tool of asArray(tools)) {
    if (!tool) continue;
    const fn = tool.function || tool;
    const originalName = String(fn.name || "tool");
    const name = nameMap.get(originalName) || originalName;
    const parameters = normalizeToolParameters(fn.parameters || tool.parameters || {});
    out.push({
      type: "function",
      name,
      description: fn.description || tool.description || "",
      parameters,
      strict: tool.strict === true
    });
  }
  return out;
}

function translateAssistantMessage(message, nameMap, knownCallIds) {
  if (!message || typeof message !== "object") return null;
  const content = translateMessageContent(message.content);
  const toolCalls = asArray(message.tool_calls).map((call, index) => {
    const fn = call?.function || {};
    const originalName = String(fn.name || "tool");
    const name = nameMap.get(originalName) || originalName;
    let args = fn.arguments ?? "{}";
    if (typeof args !== "string") {
      try { args = JSON.stringify(args); } catch { args = "{}"; }
    }
    const originalId = String(call.id || `call_${index}`);
    const callId = sanitizeChatToolCallId(originalId, knownCallIds);
    return {
      type: "function_call",
      call_id: callId,
      name,
      arguments: args
    };
  });
  return { content, toolCalls };
}

function translateToolMessage(message, knownCallIds) {
  if (!message || typeof message !== "object") return null;
  const callId = sanitizeChatToolCallId(message.tool_call_id || "call", knownCallIds);
  const content = translateMessageContent(message.content);
  return {
    type: "function_call_output",
    call_id: callId,
    output: content.length === 1 && content[0].type === "input_text"
      ? content[0].text
      : content
  };
}

export function translateChatCompletionsRequestToResponses(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const { nameMap } = buildToolNameMaps(source.tools);
  const knownCallIds = new Set();

  const systemParts = [];
  const input = [];

  for (const message of asArray(source.messages)) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "system" || message.role === "developer") {
      const text = typeof message.content === "string"
        ? message.content
        : translateMessageContent(message.content).map((p) => p.text || "").join("\n");
      if (text) systemParts.push(text);
      continue;
    }
    if (message.role === "user") {
      const content = translateMessageContent(message.content);
      if (content.length) {
        input.push({ type: "message", role: "user", content });
      }
      continue;
    }
    if (message.role === "assistant") {
      const translated = translateAssistantMessage(message, nameMap, knownCallIds);
      if (!translated) continue;
      if (translated.content.length) {
        input.push({ type: "message", role: "assistant", content: translated.content });
      }
      for (const call of translated.toolCalls) {
        input.push(call);
      }
      continue;
    }
    if (message.role === "tool") {
      const translated = translateToolMessage(message, knownCallIds);
      if (translated) input.push(translated);
      continue;
    }
  }

  const tools = translateTools(source.tools, nameMap);
  const toolChoice = translateToolChoice(source.tool_choice, nameMap);

  const reasoningEffort = source.reasoning_effort;
  const reasoning = reasoningEffort ? { effort: reasoningEffort, summary: "auto" } : undefined;

  const out = {
    model: source.model,
    input,
    stream: source.stream === true,
    parallel_tool_calls: source.parallel_tool_calls !== false,
    store: false
  };
  if (systemParts.length) {
    out.instructions = systemParts.join("\n\n");
  }
  if (tools.length) out.tools = tools;
  if (toolChoice && toolChoice !== "auto") out.tool_choice = toolChoice;
  if (reasoning) out.reasoning = reasoning;
  if (Number.isFinite(Number(source.temperature))) out.temperature = Number(source.temperature);
  if (Number.isFinite(Number(source.top_p))) out.top_p = Number(source.top_p);
  if (Number.isFinite(Number(source.max_tokens))) out.max_output_tokens = Number(source.max_tokens);
  return out;
}

function inputTextOf(part) {
  if (!part) return "";
  if (typeof part === "string") return part;
  if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
    return String(part.text || "");
  }
  return "";
}

function reasoningTextOf(item) {
  if (!item) return "";
  const summary = Array.isArray(item.summary) ? item.summary : [];
  if (summary.length) {
    return summary
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof item.reasoning === "string") return item.reasoning;
  return "";
}

function pushTextDelta(blocks, role, text, { reasoningSummary = null } = {}) {
  if (!text && !reasoningSummary) return;
  const existing = blocks.find((block) => block.role === role && block.tool_calls.length === 0 && !block.closed);
  if (existing) {
    if (text) existing.content.push({ type: "text", text });
    if (reasoningSummary) existing.reasoning_summary = reasoningSummary;
    return;
  }
  const block = { role, content: text ? [{ type: "text", text }] : [], tool_calls: [], closed: false };
  if (reasoningSummary) block.reasoning_summary = reasoningSummary;
  blocks.push(block);
}

function pushToolCallDelta(blocks, toolCall) {
  if (!toolCall || !toolCall.call_id) return;
  const existing = blocks.find((block) => block.tool_calls.some((call) => call.id === toolCall.call_id));
  if (existing) {
    const call = existing.tool_calls.find((c) => c.id === toolCall.call_id);
    if (call) {
      if (toolCall.name && !call.function.name) call.function.name = toolCall.name;
      if (toolCall.arguments) call.function.arguments = (call.function.arguments || "") + toolCall.arguments;
    }
    return;
  }
  blocks.push({
    role: "assistant",
    content: [],
    tool_calls: [{
      id: toolCall.call_id,
      type: "function",
      function: { name: toolCall.name || "", arguments: toolCall.arguments || "" }
    }],
    closed: false
  });
}

function closeLastBlock(blocks, role) {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (!blocks[i].closed && blocks[i].role === role) {
      blocks[i].closed = true;
      return;
    }
  }
}

export function chatUsageFromResponses(usage) {
  if (!usage || typeof usage !== "object") return null;
  const promptTokens = Number(usage.input_tokens);
  const completionTokens = Number(usage.output_tokens);
  const totalTokens = Number(usage.total_tokens);
  if (!Number.isFinite(promptTokens) && !Number.isFinite(completionTokens) && !Number.isFinite(totalTokens)) {
    return null;
  }
  return {
    prompt_tokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completion_tokens: Number.isFinite(completionTokens) ? completionTokens : 0,
    total_tokens: Number.isFinite(totalTokens) ? totalTokens : (promptTokens + completionTokens)
  };
}

function chatFinishFromResponse(response) {
  if (!response || typeof response !== "object") return null;
  const reason = response.stop_reason || response.incomplete_details?.reason || "";
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_output_tokens" || reason === "length") return "length";
  if (reason === "content_filter") return "content_filter";
  if (reason === "end_turn" || reason === "stop") return "stop";
  return reason || "stop";
}

function translateResponseObjectToChat(response, originalRequest = {}) {
  if (!response || typeof response !== "object") return null;
  const id = String(response.id || `chatcmpl_${Math.random().toString(36).slice(2, 10)}`);
  const model = String(response.model || originalRequest.model || "unknown");
  const created = Number.isFinite(Number(response.created_at))
    ? Math.floor(Number(response.created_at))
    : Math.floor(Date.now() / 1000);

  const blocks = [];
  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "reasoning") {
      const text = reasoningTextOf(item);
      pushTextDelta(blocks, "assistant", null, { reasoningSummary: text || null });
      continue;
    }
    if (item.type === "message") {
      const role = item.role === "assistant" ? "assistant" : "user";
      for (const part of asArray(item.content)) {
        const text = inputTextOf(part);
        if (text) pushTextDelta(blocks, role, text);
      }
      closeLastBlock(blocks, role);
      continue;
    }
    if (item.type === "function_call") {
      pushToolCallDelta(blocks, {
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments || ""
      });
      closeLastBlock(blocks, "assistant");
      continue;
    }
  }

  const messageBlocks = blocks.length
    ? blocks
    : [{ role: "assistant", content: [], tool_calls: [], closed: true }];

  const choices = messageBlocks.map((block, index) => {
    const text = block.content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .filter(Boolean)
      .join("");
    const finish = index === messageBlocks.length - 1 ? chatFinishFromResponse(response) : "stop";
    return {
      index,
      message: {
        role: block.role,
        content: block.tool_calls.length ? null : text,
        tool_calls: block.tool_calls.length ? block.tool_calls : undefined,
        refusal: block.role === "assistant" && text ? null : null
      },
      finish_reason: finish
    };
  });

  const usage = chatUsageFromResponses(response.usage);
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices,
    usage: usage || undefined
  };
}


export function translateChatResponseToResponses(payload) {
  if (!payload || typeof payload !== "object") return null;
  const choice = payload.choices && payload.choices[0];
  if (!choice) return null;
  const message = choice.message || {};
  const text = typeof message.content === "string" ? message.content : "";
  const output = [];
  if (text) output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
  for (const call of message.tool_calls || []) {
    let args = {};
    try { args = call.function && call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch { args = {}; }
    output.push({
      type: "function_call",
      call_id: call.id || "call_x",
      name: (call.function && call.function.name) || "tool",
      arguments: JSON.stringify(args)
    });
  }
  const usage = payload.usage || {};
  const finishReason = choice.finish_reason === "tool_calls" ? "tool_use"
    : choice.finish_reason === "length" ? "max_output_tokens"
      : choice.finish_reason === "content_filter" ? "content_filter"
        : "end_turn";
  return {
    id: payload.id || "resp_x",
    object: "response",
    status: "completed",
    model: payload.model || "unknown",
    output,
    usage: {
      input_tokens: Number(usage.prompt_tokens) || 0,
      output_tokens: Number(usage.completion_tokens) || 0,
      total_tokens: Number(usage.total_tokens) || 0
    },
    stop_reason: finishReason
  };
}

export function translateResponsesResponseToChat(payload) {
  if (!payload || typeof payload !== "object") return null;
  const response = payload.response && typeof payload.response === "object" ? payload.response : payload;
  return translateResponseObjectToChat(response, {});
}

function binaryAwareJsonSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? {}), "utf8");
  } catch {
    return 0;
  }
}

export function estimateChatInputTokens(payload) {
  if (!payload || typeof payload !== "object") return 0;
  let size = binaryAwareJsonSize(payload.messages);
  size += binaryAwareJsonSize(payload.tools);
  return Math.ceil(size / 4);
}

function countTokensFromBody(parsed) {
  if (!parsed || typeof parsed !== "object") return 0;
  if (Number.isFinite(Number(parsed.usage?.total_tokens))) return Number(parsed.usage.total_tokens);
  if (Number.isFinite(Number(parsed.usage?.input_tokens))) return Number(parsed.usage.input_tokens);
  return 0;
}

export function prepareChatResponsesBridge(target, body) {
  if (!isChatCompletionsPath(target) && !isResponsesPath(target) && !isResponsesCompactPath(target)) {
    return null;
  }
  const parsed = parseBody(body);
  if (!parsed) return null;

  const chatSource = isChatCompletionsPath(target);
  if (chatSource) {
    const translated = translateChatCompletionsRequestToResponses(parsed);
    const retargeted = responsesTargetFromChatTarget(target);
    return {
      kind: "responses",
      sourceShape: "chat_completions",
      originalRequest: parsed,
      translatedRequest: translated,
      target: retargeted,
      body: Buffer.from(safeJsonStringify(translated), "utf8")
    };
  }
  return null;
}

export function retargetChatResponsesBridge(target, bridge) {
  if (!bridge) return target;
  if (bridge.kind !== "responses") return target;
  return responsesTargetFromChatTarget(target);
}

function sseEvent(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function chatDeltaToResponsesEvent(delta) {
  if (!delta || typeof delta !== "object") return null;
  if (delta.role) return null;
  if (delta.content) {
    return sseEvent("response.output_text.delta", { delta: delta.content });
  }
  if (delta.tool_calls && delta.tool_calls.length) {
    const calls = [];
    for (const call of delta.tool_calls) {
      calls.push({
        type: "function_call",
        call_id: call.id,
        name: call.function?.name,
        arguments: call.function?.arguments || ""
      });
    }
    return sseEvent("response.output_item.added", { item: calls[0] });
  }
  return null;
}

function chatChoiceToResponsesEvents(choice, responseId, model) {
  const events = [];
  const message = choice?.message || {};
  const blockIndex = 0;

  events.push(sseEvent("response.created", {
    type: "response.created",
    response: {
      id: responseId,
      object: "response",
      status: "in_progress",
      model,
      output: []
    }
  }));

  if (typeof message.content === "string" && message.content.length) {
    events.push(sseEvent("response.output_item.added", {
      item: { type: "message", role: "assistant", status: "in_progress", content: [] }
    }));
    events.push(sseEvent("response.output_text.delta", { delta: message.content }));
    events.push(sseEvent("response.output_item.done", {
      item: { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: message.content }] }
    }));
  }
  for (const call of message.tool_calls || []) {
    events.push(sseEvent("response.output_item.added", {
      item: { type: "function_call", call_id: call.id, name: call.function?.name, arguments: "" }
    }));
    events.push(sseEvent("response.function_call_arguments.delta", {
      call_id: call.id,
      delta: call.function?.arguments || ""
    }));
    events.push(sseEvent("response.output_item.done", {
      item: { type: "function_call", call_id: call.id, name: call.function?.name, arguments: call.function?.arguments || "" }
    }));
  }
  events.push(sseEvent("response.completed", {
    type: "response.completed",
    response: {
      id: responseId,
      object: "response",
      status: "completed",
      model,
      output: [],
      usage: {}
    }
  }));
  void blockIndex;
  return events;
}

function parseSseData(frame) {
  const text = String(frame || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .find((payload) => payload && payload !== "[DONE]");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function nextSseBoundary(buffer) {
  const idx = buffer.indexOf("\n\n");
  if (idx === -1) return null;
  return { end: idx + 2, frame: buffer.slice(0, idx) };
}

function chatSseEvent(type, payload) {
  return `data: ${JSON.stringify({ object: "chat.completion.chunk", ...payload, object: "chat.completion.chunk" })}\n\n`;
}

export function createChatCompletionsSseTransformStream(originalRequest = {}, diagnostics = null) {
  const responseId = `chatcmpl_${Math.random().toString(36).slice(2, 12)}`;
  const model = originalRequest?.model || "unknown";
  const state = { finished: false };
  let buffer = "";
  return new Transform({
    transform(chunk, encoding, callback) {
      buffer += chunk.toString("utf8");
      let boundary = nextSseBoundary(buffer);
      while (boundary) {
        const parsed = parseSseData(boundary.frame);
        if (parsed) {
          diagnostics?.mark?.(parsed);
          if (parsed.type === "response.completed") {
            const translated = translateResponseObjectToChat(parsed.response || {}, originalRequest);
            if (translated) {
              this.push(chatSseEvent("chat.completion.chunk", translated));
            }
            this.push("data: [DONE]\n\n");
            state.finished = true;
          }
        }
        buffer = buffer.slice(boundary.end);
        boundary = nextSseBoundary(buffer);
      }
      callback();
    },
    flush(callback) {
      if (state.finished) return callback();
      const remainder = buffer.trim();
      if (remainder) {
        const parsed = parseSseData(remainder);
        if (parsed?.type === "response.completed") {
          const translated = translateResponseObjectToChat(parsed.response || {}, originalRequest);
          if (translated) {
            this.push(chatSseEvent("chat.completion.chunk", translated));
          }
          this.push("data: [DONE]\n\n");
          state.finished = true;
        }
      }
      if (!state.finished) {
        this.push("data: [DONE]\n\n");
      }
      void responseId;
      void model;
      callback();
    }
  });
}

// OpenAI Chat Completions SSE -> Responses SSE.
// Used when a Responses client is transparently retried against an upstream
// /chat/completions endpoint.
export function createChatToResponsesSseTransformStream(originalRequest = {}) {
  const responseId = `resp_${Math.random().toString(36).slice(2, 12)}`;
  const model = originalRequest?.model || "unknown";
  let buffer = "";
  let started = false;
  let text = "";
  let usage = {};
  let outputItemId = `msg_${Math.random().toString(36).slice(2, 10)}`;
  const emit = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;

  function processFrame(frame) {
    const raw = String(frame || "")
      .split(/\r?\n/)
      .find((line) => line.trimStart().startsWith("data:"));
    if (!raw) return "";
    const data = raw.slice(raw.indexOf("data:") + 5).trim();
    if (!data || data === "[DONE]") return "";
    let chunk;
    try { chunk = JSON.parse(data); } catch { return ""; }
    const choice = chunk.choices?.[0] || {};
    const delta = choice.delta || choice.message || {};
    let out = "";
    if (!started) {
      started = true;
      out += emit("response.created", {
        response: { id: responseId, object: "response", status: "in_progress", model, output: [] }
      });
      out += emit("response.output_item.added", {
        output_index: 0,
        item: { id: outputItemId, type: "message", role: "assistant", status: "in_progress", content: [] }
      });
    }
    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      out += emit("response.output_text.delta", {
        item_id: outputItemId,
        output_index: 0,
        content_index: 0,
        delta: delta.content
      });
    }
    if (chunk.usage) usage = chunk.usage;
    if (choice.finish_reason) {
      out += emit("response.output_item.done", {
        output_index: 0,
        item: {
          id: outputItemId,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text }]
        }
      });
      out += emit("response.completed", {
        response: {
          id: responseId,
          object: "response",
          status: "completed",
          model: chunk.model || model,
          output: [{
            id: outputItemId,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text }]
          }],
          usage: {
            input_tokens: Number(usage.prompt_tokens) || 0,
            output_tokens: Number(usage.completion_tokens) || 0,
            total_tokens: Number(usage.total_tokens) || 0
          },
          stop_reason: choice.finish_reason === "length" ? "max_output_tokens" : "end_turn"
        }
      });
    }
    return out;
  }

  return new Transform({
    transform(chunk, encoding, callback) {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        this.push(processFrame(frame));
      }
      callback();
    },
    flush(callback) {
      if (buffer.trim()) this.push(processFrame(buffer));
      callback();
    }
  });
}
