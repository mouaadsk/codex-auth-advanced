// Universal wire-shape translator for VSLLM.
//
// Handles all 4 shapes supported by the VSLLM gateway:
//   * responses            (OpenAI Responses API, /v1/responses)
//   * chat_completions     (OpenAI Chat Completions, /v1/chat/completions)
//   * messages             (Anthropic Messages, /v1/messages)
//   * antigravity          (Google Gemini :generateContent, /v1beta/models/{m}:generateContent)
//
// For every non-identity source -> target pair the module exposes:
//
//   translateRequest(sourceShape, targetShape, payload)
//     -> { body, model, ... }  (target-shape wire format)
//
//   translateResponse(sourceShape, targetShape, payload, originalRequest)
//     -> parsed JSON object in the target shape, or null on failure
//
//   buildShapeBridge(target, sourceShape, targetShape, sourceBody, sourceRequest)
//     -> { kind, target, body, originalRequest, sourceShape, targetShape }
//        ready for the proxy chain walker to assign to its current target.
//
// The chain walker in provider-proxy.mjs calls buildShapeBridge to advance
// to the next wire shape on the same VSLLM account when the current shape's
// endpoint does not respond. After upstream returns, it calls
// translateResponse to convert the response back to the source shape before
// forwarding to the client.

import { WIRE_SHAPES } from "./provider-policy.mjs";
import {
  translateChatCompletionsRequestToResponses,
  translateChatResponseToResponses,
  translateResponsesResponseToChat
} from "./chat-responses-bridge.mjs";
import {
  translateClaudeMessagesRequestToResponses,
  translateClaudeMessagesRequestToChat,
  translateMessagesResponseToResponses,
  translateChatResponseToClaude,
  translateResponsesResponseToClaude
} from "./claude-responses-bridge.mjs";
import {
  prepareAntigravityBridge,
  retargetAntigravityBridge,
  translateAntigravityResponseToShape
} from "./antigravity-bridge.mjs";

const SHAPE_PATH = {
  [WIRE_SHAPES.RESPONSES]: "/v1/responses",
  [WIRE_SHAPES.MESSAGES]: "/v1/messages",
  [WIRE_SHAPES.CHAT_COMPLETIONS]: "/v1/chat/completions"
};

function parseBody(body) {
  if (!body) return null;
  if (typeof body === "object") return body;
  const raw = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function stringifyBody(obj) {
  try { return Buffer.from(JSON.stringify(obj ?? {}), "utf8"); }
  catch { return null; }
}

function shapeBaseUrl(target) {
  return target?.upstreamBaseUrl || target?.upstreamUrl || target?.account?.base_url || null;
}

function shapeUrlFor(baseUrl, shape) {
  const base = String(baseUrl || "").replace(/\/$/, "");
  const suffix = SHAPE_PATH[shape];
  if (!base || !suffix) return null;
  return `${base}${suffix}`;
}

function safeJsonParse(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

// ---------- Request translators (source -> target) ----------

function responsesToChatRequest(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const messages = [];
  let systemText = "";
  for (const item of Array.isArray(source.input) ? source.input : []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "message") {
      const text = Array.isArray(item.content)
        ? item.content.map((p) => (p && typeof p === "object" ? (p.text || "") : String(p || ""))).join("\n")
        : (typeof item.content === "string" ? item.content : "");
      const role = item.role === "assistant" ? "assistant" : "user";
      if (role === "system") { systemText += (systemText ? "\n" : "") + text; continue; }
      messages.push({ role, content: text });
      continue;
    }
    if (item.type === "function_call") {
      const last = messages[messages.length - 1];
      const toolCall = {
        id: item.call_id || `call_${messages.length}`,
        type: "function",
        function: { name: item.name || "tool", arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}) }
      };
      if (last && last.role === "assistant") {
        last.tool_calls = [...(last.tool_calls || []), toolCall];
        if (!last.content) last.content = null;
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [toolCall] });
      }
      continue;
    }
    if (item.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id || "", content: typeof item.output === "string" ? item.output : JSON.stringify(item.output || "") });
    }
  }
  const out = { model: source.model, messages, stream: source.stream === true };
  if (systemText) messages.unshift({ role: "system", content: systemText });
  if (Array.isArray(source.tools) && source.tools.length) {
    out.tools = source.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name || tool.function?.name || "tool",
        description: tool.description || tool.function?.description || "",
        parameters: tool.parameters || tool.function?.parameters || {}
      }
    }));
  }
  if (source.reasoning?.effort) out.reasoning_effort = source.reasoning.effort;
  if (source.temperature != null) out.temperature = source.temperature;
  return out;
}

function responsesToMessagesRequest(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const messages = [];
  let system = "";
  for (const item of Array.isArray(source.input) ? source.input : []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "message") {
      const text = Array.isArray(item.content)
        ? item.content.map((p) => (p && typeof p === "object" ? (p.text || "") : String(p || ""))).join("\n")
        : (typeof item.content === "string" ? item.content : "");
      const role = item.role === "assistant" ? "assistant" : "user";
      if (role === "system") { system += (system ? "\n\n" : "") + text; continue; }
      messages.push({ role, content: [{ type: "text", text }] });
      continue;
    }
    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: [{
          type: "tool_use",
          id: item.call_id || `toolu_${messages.length}`,
          name: item.name || "tool",
          input: typeof item.arguments === "string" ? safeJsonParse(item.arguments, {}) : (item.arguments || {})
        }]
      });
      continue;
    }
    if (item.type === "function_call_output") {
      const text = typeof item.output === "string" ? item.output : JSON.stringify(item.output || "");
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: item.call_id || "", content: text }] });
    }
  }
  const out = { model: source.model, messages, max_tokens: 4096 };
  if (system) out.system = system;
  if (Array.isArray(source.tools) && source.tools.length) {
    out.tools = source.tools.map((tool) => ({
      name: tool.name || tool.function?.name || "tool",
      description: tool.description || tool.function?.description || "",
      input_schema: tool.parameters || tool.function?.parameters || { type: "object", properties: {} }
    }));
  }
  return out;
}

function chatToMessagesRequest(payload) {
  const intermediate = translateChatCompletionsRequestToResponses(payload || {});
  return responsesToMessagesRequest(intermediate);
}

// ---------- Response translators (source -> target) ----------

function messagesToChatResponse(payload, originalRequest = {}) {
  const intermediate = translateMessagesResponseToResponses(payload, originalRequest);
  if (!intermediate) return null;
  return translateResponsesResponseToChat(intermediate);
}

function chatToMessagesResponse(payload, originalRequest = {}) {
  const intermediate = translateChatResponseToResponses(payload);
  if (!intermediate) return null;
  return translateResponsesResponseToClaude(intermediate, originalRequest);
}

// ---------- Dispatch tables ----------

const REQUEST_TRANSLATORS = {
  [`${WIRE_SHAPES.RESPONSES}:${WIRE_SHAPES.CHAT_COMPLETIONS}`]: responsesToChatRequest,
  [`${WIRE_SHAPES.RESPONSES}:${WIRE_SHAPES.MESSAGES}`]: responsesToMessagesRequest,
  [`${WIRE_SHAPES.RESPONSES}:${WIRE_SHAPES.ANTIGRAVITY}`]: null,
  [`${WIRE_SHAPES.CHAT_COMPLETIONS}:${WIRE_SHAPES.RESPONSES}`]: (payload) => translateChatCompletionsRequestToResponses(payload),
  [`${WIRE_SHAPES.CHAT_COMPLETIONS}:${WIRE_SHAPES.MESSAGES}`]: chatToMessagesRequest,
  [`${WIRE_SHAPES.CHAT_COMPLETIONS}:${WIRE_SHAPES.ANTIGRAVITY}`]: null,
  [`${WIRE_SHAPES.MESSAGES}:${WIRE_SHAPES.RESPONSES}`]: (payload) => translateClaudeMessagesRequestToResponses(payload),
  [`${WIRE_SHAPES.MESSAGES}:${WIRE_SHAPES.CHAT_COMPLETIONS}`]: (payload) => translateClaudeMessagesRequestToChat(payload),
  [`${WIRE_SHAPES.MESSAGES}:${WIRE_SHAPES.ANTIGRAVITY}`]: null,
  [`${WIRE_SHAPES.ANTIGRAVITY}:${WIRE_SHAPES.RESPONSES}`]: null,
  [`${WIRE_SHAPES.ANTIGRAVITY}:${WIRE_SHAPES.CHAT_COMPLETIONS}`]: null,
  [`${WIRE_SHAPES.ANTIGRAVITY}:${WIRE_SHAPES.MESSAGES}`]: null
};

const RESPONSE_TRANSLATORS = {
  [`${WIRE_SHAPES.RESPONSES}:${WIRE_SHAPES.CHAT_COMPLETIONS}`]: (payload) => translateResponsesResponseToChat(payload),
  [`${WIRE_SHAPES.RESPONSES}:${WIRE_SHAPES.MESSAGES}`]: (payload, original) => translateResponsesResponseToClaude(payload, original),
  [`${WIRE_SHAPES.RESPONSES}:${WIRE_SHAPES.ANTIGRAVITY}`]: null,
  [`${WIRE_SHAPES.CHAT_COMPLETIONS}:${WIRE_SHAPES.RESPONSES}`]: (payload) => translateChatResponseToResponses(payload),
  [`${WIRE_SHAPES.CHAT_COMPLETIONS}:${WIRE_SHAPES.MESSAGES}`]: (payload, original) => chatToMessagesResponse(payload, original),
  [`${WIRE_SHAPES.CHAT_COMPLETIONS}:${WIRE_SHAPES.ANTIGRAVITY}`]: null,
  [`${WIRE_SHAPES.MESSAGES}:${WIRE_SHAPES.RESPONSES}`]: (payload, original) => translateMessagesResponseToResponses(payload, original),
  [`${WIRE_SHAPES.MESSAGES}:${WIRE_SHAPES.CHAT_COMPLETIONS}`]: (payload, original) => messagesToChatResponse(payload, original),
  [`${WIRE_SHAPES.MESSAGES}:${WIRE_SHAPES.ANTIGRAVITY}`]: null,
  [`${WIRE_SHAPES.ANTIGRAVITY}:${WIRE_SHAPES.RESPONSES}`]: (payload, original) => translateAntigravityResponseToShape(payload, WIRE_SHAPES.RESPONSES, original)?.body || null,
  [`${WIRE_SHAPES.ANTIGRAVITY}:${WIRE_SHAPES.CHAT_COMPLETIONS}`]: (payload, original) => translateAntigravityResponseToShape(payload, WIRE_SHAPES.CHAT_COMPLETIONS, original)?.body || null,
  [`${WIRE_SHAPES.ANTIGRAVITY}:${WIRE_SHAPES.MESSAGES}`]: (payload, original) => translateAntigravityResponseToShape(payload, WIRE_SHAPES.MESSAGES, original)?.body || null
};

export function translateRequest(sourceShape, targetShape, payload) {
  if (sourceShape === targetShape) return payload;
  const fn = REQUEST_TRANSLATORS[`${sourceShape}:${targetShape}`];
  if (!fn) return null;
  try {
    const parsed = parseBody(payload);
    if (!parsed) return null;
    return fn(parsed);
  } catch {
    return null;
  }
}

export function translateResponse(sourceShape, targetShape, payload, originalRequest = {}) {
  if (sourceShape === targetShape) return payload;
  const fn = RESPONSE_TRANSLATORS[`${sourceShape}:${targetShape}`];
  if (!fn) return null;
  try {
    const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
    if (!parsed || typeof parsed !== "object") return null;
    return fn(parsed, originalRequest || {});
  } catch {
    return null;
  }
}

export function buildShapeBridge({ target, sourceShape, targetShape, sourceBody, sourceRequest }) {
  if (!target || !sourceShape || !targetShape) return null;
  if (sourceShape === targetShape) return null;

  if (targetShape === WIRE_SHAPES.ANTIGRAVITY) {
    const bridge = prepareAntigravityBridge(target, sourceBody);
    if (!bridge || bridge.kind !== "antigravity") return null;
    return {
      kind: "antigravity",
      sourceShape,
      targetShape,
      target: bridge.target,
      body: bridge.body,
      originalRequest: bridge.originalRequest,
      translatedRequest: bridge.translatedRequest,
      retarget: (t) => retargetAntigravityBridge(t, bridge)
    };
  }
  if (sourceShape === WIRE_SHAPES.ANTIGRAVITY) return null;

  const baseUrl = shapeBaseUrl(target);
  if (!baseUrl) return null;
  const newUrl = shapeUrlFor(baseUrl, targetShape);
  if (!newUrl) return null;

  const parsedRequest = sourceRequest || parseBody(sourceBody);
  if (!parsedRequest) return null;
  const translated = translateRequest(sourceShape, targetShape, parsedRequest);
  if (!translated) return null;
  const newBody = stringifyBody(translated);
  if (!newBody) return null;

  return {
    kind: targetShape,
    sourceShape,
    targetShape,
    target: { ...target, url: newUrl },
    body: newBody,
    originalRequest: parsedRequest,
    translatedRequest: translated
  };
}

export function retargetBridge(bridge, newTarget) {
  if (!bridge || !newTarget) return bridge;
  if (bridge.kind === "antigravity") {
    return {
      ...bridge,
      target: bridge.retarget ? bridge.retarget(newTarget) : newTarget
    };
  }
  const baseUrl = shapeBaseUrl(newTarget);
  if (!baseUrl) return bridge;
  const newUrl = shapeUrlFor(baseUrl, bridge.targetShape);
  return {
    ...bridge,
    target: { ...newTarget, url: newUrl || newTarget.url }
  };
}

export const SHAPE_TRANSLATOR_SUPPORTED = Object.freeze({
  requestPairs: Object.freeze(Object.keys(REQUEST_TRANSLATORS).filter((k) => REQUEST_TRANSLATORS[k] != null)),
  responsePairs: Object.freeze(Object.keys(RESPONSE_TRANSLATORS).filter((k) => RESPONSE_TRANSLATORS[k] != null))
});
