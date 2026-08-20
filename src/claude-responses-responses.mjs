import {
  buildToolNameMaps,
  reasoningText,
  responseStopReason,
  responseStopSequence,
  responseUsage,
  sanitizeClaudeToolId
} from "./claude-responses-core.mjs";

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

// ---------- Claude Messages <-> Chat Completions ----------
//
// Light bridge: Chat Completions and Anthropic Messages share the same
// structural skeleton (system + messages + tools), so the conversion is a
// matter of content-part translation, tool-name remapping, and stop-reason
// mapping. We do not implement SSE streaming translation here; the
// failover planner can request non-streaming retries when SSE-only translation
// would be lossy.

export function translateClaudeMessagesRequestToChat(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const tools = Array.isArray(source.tools) ? source.tools : [];
  const { nameMap } = (() => {
    const { buildToolNameMaps } = { buildToolNameMaps: (toolsList) => {
      const m = new Map();
      const reverse = new Map();
      toolsList.forEach((tool, i) => {
        const orig = String(tool?.name || `tool_${i}`);
        const short = orig.length <= 64 ? orig : `${orig.slice(0, 55)}__${i}`;
        m.set(orig, short);
        reverse.set(short, orig);
      });
      return { nameMap: m, reverseMap: reverse };
    }};
    return buildToolNameMaps(tools);
  })();
  const knownCallIds = new Set();

  const system = Array.isArray(source.system)
    ? source.system
      .filter((part) => part && (part.type === "text" || part.type === undefined))
      .map((part) => String(part.text || ""))
      .filter(Boolean)
      .join("\n\n")
    : (typeof source.system === "string" ? source.system : "");

  const messages = [];
  if (system) messages.push({ role: "system", content: system });

  for (const message of Array.isArray(source.messages) ? source.messages : []) {
    if (!message || typeof message !== "object") continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    if (Array.isArray(message.content)) {
      const toolUses = message.content.filter((part) => part && part.type === "tool_use");
      const textParts = message.content.filter((part) => part && (part.type === "text" || part.type === undefined));
      const text = textParts.map((part) => String(part.text || "")).filter(Boolean).join("");
      const toolCalls = toolUses.map((block, index) => {
        const originalName = String(block.name || "tool");
        const name = nameMap.get(originalName) || originalName;
        let args = "{}";
        if (block.input && typeof block.input === "object") {
          try { args = JSON.stringify(block.input); } catch { args = "{}"; }
        }
        const id = `${block.id || `toolu_${index}`}`.slice(0, CALL_ID_LIMIT);
        knownCallIds.add(id);
        return { id, type: "function", function: { name, arguments: args } };
      });
      messages.push({
        role,
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      });
      continue;
    }
    if (typeof message.content === "string") {
      messages.push({ role, content: message.content });
      continue;
    }
    if (Array.isArray(message.content) && message.content.some((part) => part?.type === "tool_result")) {
      const toolCallId = message.content.find((part) => part?.type === "tool_result")?.tool_use_id || "";
      const resultContent = message.content
        .filter((part) => part && part.type === "tool_result")
        .map((part) => Array.isArray(part.content) ? part.content.map((sub) => sub?.text || "").join("\n") : String(part.content || ""))
        .join("\n");
      messages.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: resultContent
      });
      continue;
    }
  }

  const translatedTools = tools.map((tool, i) => {
    const name = nameMap.get(String(tool.name || `tool_${i}`)) || tool.name;
    return {
      type: "function",
      function: {
        name,
        description: tool.description || "",
        parameters: tool.input_schema || {}
      }
    };
  });

  const out = {
    model: source.model,
    messages,
    stream: source.stream === true
  };
  if (translatedTools.length) out.tools = translatedTools;
  if (source.tool_choice && typeof source.tool_choice === "object") {
    const name = source.tool_choice.name ? (nameMap.get(source.tool_choice.name) || source.tool_choice.name) : undefined;
    if (name) out.tool_choice = { type: "function", function: { name } };
    else if (source.tool_choice.type === "any") out.tool_choice = "auto";
    else out.tool_choice = source.tool_choice.type || "auto";
  } else if (typeof source.tool_choice === "string") {
    out.tool_choice = source.tool_choice === "any" ? "auto" : source.tool_choice;
  }
  if (Number.isFinite(Number(source.max_tokens))) out.max_tokens = Number(source.max_tokens);
  if (Number.isFinite(Number(source.temperature))) out.temperature = Number(source.temperature);
  if (source.thinking && source.thinking.type === "enabled" && Number.isFinite(Number(source.thinking.budget_tokens))) {
    out.reasoning_effort = "high";
  }
  return out;
}


export function translateMessagesResponseToResponses(payload, originalRequest = {}) {
  if (!payload || typeof payload !== "object") return null;
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  const output = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: block.text }] });
      continue;
    }
    if (block.type === "tool_use") {
      output.push({
        type: "function_call",
        call_id: block.id || "call_x",
        name: block.name || "tool",
        arguments: JSON.stringify(block.input || {})
      });
    }
  }
  const usage = payload.usage || {};
  const finishReason = payload.stop_reason === "tool_use" ? "tool_use"
    : payload.stop_reason === "max_tokens" ? "max_output_tokens"
      : payload.stop_reason === "refusal" ? "content_filter"
        : "end_turn";
  return {
    id: payload.id || "resp_x",
    object: "response",
    status: "completed",
    model: payload.model || originalRequest.model || "unknown",
    output,
    usage: {
      input_tokens: Number(usage.input_tokens) || 0,
      output_tokens: Number(usage.output_tokens) || 0,
      total_tokens: (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0)
    },
    stop_reason: finishReason
  };
}

export function translateChatResponseToClaude(payload, originalRequest = {}) {
  if (!payload || typeof payload !== "object") return null;
  const choice = payload.choices?.[0];
  if (!choice) return null;
  const message = choice.message || {};
  const text = typeof message.content === "string" ? message.content : "";
  const blocks = [];
  if (text) blocks.push({ type: "text", text });
  for (const call of message.tool_calls || []) {
    let input = {};
    try {
      input = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      input = {};
    }
    blocks.push({ type: "tool_use", id: call.id || `toolu_${blocks.length}`, name: call.function?.name || "tool", input });
  }
  const stopReason = choice.finish_reason === "tool_calls" ? "tool_use"
    : choice.finish_reason === "length" ? "max_tokens"
      : choice.finish_reason === "content_filter" ? "refusal"
        : "end_turn";
  return {
    id: payload.id || `msg_${Math.random().toString(36).slice(2, 10)}`,
    type: "message",
    role: "assistant",
    model: payload.model || originalRequest.model || "unknown",
    content: blocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: chatUsageFromResponses(payload.usage) || { input_tokens: 0, output_tokens: 0 }
  };
}

export function chatTargetFromClaudeTarget(target) {
  const url = new URL(target.url);
  url.pathname = url.pathname.replace(/\/v1\/messages\/?$/, "/v1/chat/completions");
  url.search = "";
  return {
    ...target,
    url: url.toString(),
    claudeChatBridge: true
  };
}

export function messagesTargetFromChatTarget(target) {
  const url = new URL(target.url);
  url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, "/v1/messages");
  url.search = "";
  return {
    ...target,
    url: url.toString(),
    claudeChatBridge: true
  };
}

export function prepareClaudeChatBridge(target, body) {
  if (!target?.url) return null;
  try {
    const path = new URL(target.url).pathname.replace(/\/$/, "");
    if (!path.endsWith("/messages")) return null;
  } catch { return null; }
  if (!body) return null;
  const raw = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const translated = translateClaudeMessagesRequestToChat(parsed);
  return {
    kind: "chat_completions",
    sourceShape: "messages",
    originalRequest: parsed,
    translatedRequest: translated,
    target: chatTargetFromClaudeTarget(target),
    body: Buffer.from(JSON.stringify(translated), "utf8")
  };
}
