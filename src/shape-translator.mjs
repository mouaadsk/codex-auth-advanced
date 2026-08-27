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
} from "./chat-responses-core.mjs";
import { translateClaudeMessagesRequestToResponses } from "./claude-responses-core.mjs";
import {
  translateClaudeMessagesRequestToChat,
  translateMessagesResponseToResponses,
  translateChatResponseToClaude,
  translateResponsesResponseToClaude
} from "./claude-responses-responses.mjs";
import { Transform } from "node:stream";
import {
  prepareAntigravityBridge,
  retargetAntigravityBridge,
  translateAntigravityResponseToShape,
  createAntigravitySseTransformStream,
  responsesToGeminiRequest,
  messagesToGeminiRequest,
  chatToGeminiRequest,
  geminiRequestToResponsesRequest
} from "./antigravity-bridge.mjs";
import { createChatToResponsesSseTransformStream } from "./chat-responses-sse.mjs";

const SHAPE_PATH = {
  [WIRE_SHAPES.RESPONSES]: "/v1/responses",
  [WIRE_SHAPES.MESSAGES]: "/v1/messages",
  [WIRE_SHAPES.CHAT_COMPLETIONS]: "/v1/chat/completions"
};

function parseBody(body) {
  if (!body) return null;
  if (Buffer.isBuffer(body)) {
    if (body.length === 0) return null;
    try { return JSON.parse(body.toString("utf8")); } catch { return null; }
  }
  if (typeof body === "object") {
    // Could already be a parsed object, but skip Buffer-like objects
    if (body && body.type === "Buffer") {
      try { return JSON.parse(Buffer.from(body.data || []).toString("utf8")); } catch { return null; }
    }
    return body;
  }
  const raw = String(body);
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
  const raw = String(baseUrl || "").replace(/\/$/, "");
  if (!raw) return null;
  // If baseUrl already ends with /v1, don't add another.
  const base = /\/v1$/.test(raw) ? raw : `${raw}/v1`;
  const suffix = SHAPE_PATH[shape];
  if (!suffix) return null;
  // SHAPE_PATH already includes /v1, so strip it before concatenation.
  const cleanSuffix = suffix.startsWith("/v1") ? suffix.slice(3) : suffix;
  return `${base}${cleanSuffix}`;
}

function safeJsonParse(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

// ---------- Request translators (source -> target) ----------

// Responses and Chat Completions use different object forms for a named
// function choice.  Keep the caller's explicit policy when a Responses
// request is retried against /chat/completions; silently dropping it changes
// a required tool call into provider-default (auto) behavior.
function responsesToolChoiceToChat(toolChoice) {
  if (toolChoice == null) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  if (typeof toolChoice !== "object" || Array.isArray(toolChoice)) return toolChoice;

  if (toolChoice.type === "function") {
    const name = toolChoice.name || toolChoice.function?.name;
    return name
      ? { type: "function", function: { name: String(name) } }
      : undefined;
  }

  // Responses' allowed_tools form has no exact Chat Completions equivalent.
  // Preserve its required/auto intent rather than dropping the policy.  The
  // tool list itself is still forwarded, so the provider can apply the
  // closest available restriction.
  if (toolChoice.type === "allowed_tools") {
    if (toolChoice.mode === "required" || toolChoice.mode === "none" || toolChoice.mode === "auto") {
      return toolChoice.mode;
    }
    return "auto";
  }

  return toolChoice;
}

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
  if (typeof source.instructions === "string" && source.instructions.trim()) {
    if (systemText) systemText = source.instructions + (systemText ? "\n\n" + systemText : "");
    else systemText = source.instructions.trim();
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
  const toolChoice = responsesToolChoiceToChat(source.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  if (typeof source.parallel_tool_calls === "boolean") {
    out.parallel_tool_calls = source.parallel_tool_calls;
  }
  if (source.reasoning?.effort) out.reasoning_effort = source.reasoning.effort;
  if (source.temperature != null) out.temperature = source.temperature;
  if (source.top_p != null) out.top_p = source.top_p;
  if (source.max_output_tokens != null) out.max_tokens = source.max_output_tokens;
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
  if (typeof source.instructions === "string" && source.instructions.trim()) {
    if (system) system = source.instructions + (system ? "\n\n" + system : "");
    else system = source.instructions.trim();
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

// ---------- Antigravity -> X (Chat / Claude) ----------

function geminiRequestToChatRequest(payload) {
  const responsesObj = geminiRequestToResponsesRequest(payload);
  if (!responsesObj) return null;
  return responsesToChatRequest(responsesObj);
}

function geminiRequestToMessagesRequest(payload) {
  const responsesObj = geminiRequestToResponsesRequest(payload);
  if (!responsesObj) return null;
  return responsesToMessagesRequest(responsesObj);
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
  [`${WIRE_SHAPES.RESPONSES}:${WIRE_SHAPES.ANTIGRAVITY}`]: (payload) => responsesToGeminiRequest(payload),
  [`${WIRE_SHAPES.CHAT_COMPLETIONS}:${WIRE_SHAPES.RESPONSES}`]: (payload) => translateChatCompletionsRequestToResponses(payload),
  [`${WIRE_SHAPES.CHAT_COMPLETIONS}:${WIRE_SHAPES.MESSAGES}`]: chatToMessagesRequest,
  [`${WIRE_SHAPES.CHAT_COMPLETIONS}:${WIRE_SHAPES.ANTIGRAVITY}`]: (payload) => chatToGeminiRequest(payload),
  [`${WIRE_SHAPES.MESSAGES}:${WIRE_SHAPES.RESPONSES}`]: (payload) => translateClaudeMessagesRequestToResponses(payload),
  [`${WIRE_SHAPES.MESSAGES}:${WIRE_SHAPES.CHAT_COMPLETIONS}`]: (payload) => translateClaudeMessagesRequestToChat(payload),
  [`${WIRE_SHAPES.MESSAGES}:${WIRE_SHAPES.ANTIGRAVITY}`]: (payload) => messagesToGeminiRequest(payload),
  [`${WIRE_SHAPES.ANTIGRAVITY}:${WIRE_SHAPES.RESPONSES}`]: (payload) => geminiRequestToResponsesRequest(payload),
  [`${WIRE_SHAPES.ANTIGRAVITY}:${WIRE_SHAPES.CHAT_COMPLETIONS}`]: (payload) => geminiRequestToChatRequest(payload),
  [`${WIRE_SHAPES.ANTIGRAVITY}:${WIRE_SHAPES.MESSAGES}`]: (payload) => geminiRequestToMessagesRequest(payload)
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

// ---------- SSE streaming translators ----------
//
// When the chain walker retargets a streaming request to a different wire
// shape on the same upstream, the response is still streamed as SSE in the
// new shape's event format. This module emits a Transform that consumes the
// new shape's events and re-emits them in the source shape's format.
//
// Supported pairs:
//   chat_completions -> responses
//   chat_completions -> messages
//   responses        -> chat_completions
//   responses        -> messages
//   messages         -> responses
//   messages         -> chat_completions
//   * -> antigravity  (uses createAntigravitySseTransformStream)

function sseEvent(eventName, dataObj) {
  return `event: ${eventName}\ndata: ${JSON.stringify(dataObj)}\n\n`;
}
function sseData(dataObj) {
  return `data: ${JSON.stringify(dataObj)}\n\n`;
}
function sseDone() {
  return `data: [DONE]\n\n`;
}
function sseBytes(text) {
  return Buffer.from(text, "utf8");
}

function nextSseBoundary(buffer) {
  const idx = buffer.indexOf("\n\n");
  if (idx < 0) return null;
  return { index: idx, length: 2 };
}

function parseSseFrame(frame) {
  const text = String(frame || "").trim();
  if (!text) return null;
  let eventName = "message";
  let dataLines = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  const data = dataLines.join("\n");
  if (!data) return { eventName, data: null };
  if (data === "[DONE]") return { eventName, data: "[DONE]" };
  try { return { eventName, data: JSON.parse(data) }; }
  catch { return { eventName, data: null }; }
}

function responsesEvents() {
  // Translate Responses SSE events -> Chat Completions SSE events.
  // Supports text and tool_calls (function_call) deltas.
  const state = { responseId: null, model: null, outputItemId: null, text: "", started: false, usage: {}, finishReason: null, toolCallIndex: 0, toolCallsSeen: [] };
  function chatChunk(delta, finishReason) {
    return sseData({
      id: state.responseId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: state.model || "unknown",
      choices: [{ index: 0, delta, finish_reason: finishReason || null }]
    });
  }
  return function(event) {
    if (!event || event.data == null) return "";
    const e = event.data;
    if (e.type === "response.created" && e.response) {
      state.responseId = e.response.id;
      state.model = e.response.model || state.model;
      return "";
    }
    if (e.type === "response.output_item.added") {
      state.outputItemId = e.item?.id || state.outputItemId;
      state.started = true;
      if (e.item?.type === "function_call") {
        // Open a Chat-style tool_call delta with id + name
        const toolCall = {
          index: state.toolCallIndex,
          id: e.item.call_id || e.item.id || `call_${state.toolCallIndex}`,
          type: "function",
          function: { name: e.item.name || "", arguments: "" }
        };
        state.toolCallsSeen.push(toolCall);
        state.toolCallIndex += 1;
        return chatChunk({ role: "assistant", content: null, tool_calls: [toolCall] });
      }
      return chatChunk({ role: "assistant", content: "" });
    }
    if (e.type === "response.output_text.delta" && e.delta) {
      return chatChunk({ content: e.delta });
    }
    if (e.type === "response.function_call_arguments.delta" && e.delta) {
      const lastTool = state.toolCallsSeen[state.toolCallsSeen.length - 1];
      if (lastTool) {
        return chatChunk({ tool_calls: [{ index: lastTool.index, function: { arguments: e.delta } }] });
      }
    }
    if (e.type === "response.completed" || e.type === "response.incomplete") {
      const response = e.response || {};
      state.finishReason = response.stop_reason === "max_output_tokens" ? "length"
        : response.stop_reason === "tool_use" ? "tool_calls"
        : "stop";
      let out = chatChunk({}, state.finishReason);
      if (response.usage) {
        out += sseData({
          id: response.id || state.responseId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: response.model || state.model || "unknown",
          choices: [],
          usage: {
            prompt_tokens: response.usage.input_tokens || 0,
            completion_tokens: response.usage.output_tokens || 0,
            total_tokens: response.usage.total_tokens || 0
          }
        });
      }
      return out + sseDone();
    }
    return "";
  };
}

function responsesToMessagesEvents(originalRequest = {}) {
  // Translate Responses SSE events -> Anthropic Messages SSE events.
  // Supports text and tool_use (function_call) deltas.
  const state = { messageId: null, model: null, blockIndex: 0, textBlockOpen: false, finishReason: null, toolBlocks: new Map() };
  function openTextBlock() {
    if (state.textBlockOpen) return "";
    state.textBlockOpen = true;
    return sseEvent("content_block_start", { type: "content_block_start", index: state.blockIndex, content_block: { type: "text", text: "" } });
  }
  function closeTextBlock() {
    if (!state.textBlockOpen) return "";
    state.textBlockOpen = false;
    const idx = state.blockIndex; state.blockIndex += 1;
    return sseEvent("content_block_stop", { type: "content_block_stop", index: idx });
  }
  function ensureMessageStart(response) {
    if (state.messageId) return "";
    state.messageId = response.id || `msg_${Math.random().toString(36).slice(2, 12)}`;
    state.model = response.model || originalRequest?.model || "";
    return sseEvent("message_start", {
      type: "message_start",
      message: {
        id: state.messageId, type: "message", role: "assistant", model: state.model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  }
  return function(event) {
    if (!event || event.data == null || event.data === "[DONE]") return "";
    const e = event.data;
    if (e.type === "response.created" && e.response) {
      return ensureMessageStart(e.response);
    }
    if (e.type === "response.output_item.added" && e.item?.type === "function_call") {
      const idx = state.blockIndex; state.blockIndex += 1;
      state.toolBlocks.set(e.item.id || e.item.call_id, idx);
      return sseEvent("content_block_start", {
        type: "content_block_start", index: idx,
        content_block: { type: "tool_use", id: e.item.call_id || e.item.id, name: e.item.name || "", input: {} }
      });
    }
    if (e.type === "response.output_text.delta" && e.delta) {
      return openTextBlock() + sseEvent("content_block_delta", {
        type: "content_block_delta", index: state.blockIndex,
        delta: { type: "text_delta", text: e.delta }
      });
    }
    if (e.type === "response.function_call_arguments.delta" && e.delta) {
      // Find the latest open tool_use block
      const lastIdx = Array.from(state.toolBlocks.values()).pop();
      if (lastIdx != null) {
        return sseEvent("content_block_delta", {
          type: "content_block_delta", index: lastIdx,
          delta: { type: "input_json_delta", partial_json: e.delta }
        });
      }
    }
    if (e.type === "response.output_item.done" && e.item?.type === "function_call") {
      const idx = state.toolBlocks.get(e.item.id || e.item.call_id);
      if (idx != null) {
        return sseEvent("content_block_stop", { type: "content_block_stop", index: idx });
      }
    }
    if (e.type === "response.completed" || e.type === "response.incomplete") {
      const response = e.response || {};
      const reason = response.stop_reason === "max_output_tokens" ? "max_tokens"
        : response.stop_reason === "tool_use" ? "tool_use"
        : "end_turn";
      return closeTextBlock() + sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: reason, stop_sequence: null },
        usage: response.usage || { input_tokens: 0, output_tokens: 0 }
      }) + sseEvent("message_stop", { type: "message_stop" });
    }
    return "";
  };
}

function chatEvents() {
  // Translate Chat Completions SSE events -> Responses SSE events.
  // Supports text and tool_calls deltas (tool_calls[].function.arguments partial).
  const state = { responseId: null, model: null, started: false, text: "", usage: {}, finishReason: null, toolCalls: new Map(), toolOrder: [], outputItems: [] };
  function emitEvent(type, payload) { return sseData({ type, ...payload }); }
  function responseCompleted() {
    const output = state.outputItems.length ? state.outputItems : [];
    return emitEvent("response.completed", {
      response: {
        id: state.responseId, object: "response", status: "completed",
        model: state.model || "unknown",
        output,
        usage: { input_tokens: Number(state.usage.prompt_tokens) || 0, output_tokens: Number(state.usage.completion_tokens) || 0, total_tokens: Number(state.usage.total_tokens) || 0 },
        stop_reason: state.finishReason === "length" ? "max_output_tokens" : state.finishReason === "tool_calls" ? "tool_use" : "end_turn"
      }
    });
  }
  function ensureStarted(e) {
    if (state.started) return "";
    state.started = true;
    state.responseId = e.id || `resp_${Math.random().toString(36).slice(2, 12)}`;
    state.model = e.model || state.model;
    return emitEvent("response.created", {
      response: { id: state.responseId, object: "response", status: "in_progress", model: state.model, output: [] }
    });
  }
  function ensureMessageOutputItem() {
    if (state.textOutputItemId) return state.textOutputItemId;
    const id = `msg_${Math.random().toString(36).slice(2, 10)}`;
    state.textOutputItemId = id;
    state.outputItems.push({ id, type: "message", role: "assistant", status: "in_progress", content: [] });
    return id;
  }
  return function(event) {
    if (!event || event.data == null || event.data === "[DONE]") {
      if (event && event.data === "[DONE]" && state.started) return responseCompleted();
      return "";
    }
    const e = event.data;
    const choice = e.choices?.[0];
    if (!choice) {
      if (e.usage) state.usage = e.usage;
      return "";
    }
    const delta = choice.delta || choice.message || {};
    let out = ensureStarted(e);

    if (typeof delta.content === "string" && delta.content) {
      state.text += delta.content;
      const msgId = ensureMessageOutputItem();
      out += emitEvent("response.output_text.delta", { item_id: msgId, output_index: 0, content_index: 0, delta: delta.content });
    }

    // Handle tool_calls deltas (OpenAI Chat sends one tool_call per delta with index)
    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const tc of toolCalls) {
      const idx = tc.index ?? 0;
      let record = state.toolCalls.get(idx);
      if (!record) {
        const newId = tc.id || `call_${Math.random().toString(36).slice(2, 10)}`;
        record = {
          id: newId,
          outputItemId: `fc_${Math.random().toString(36).slice(2, 10)}`,
          name: tc.function?.name || "",
          arguments: ""
        };
        state.toolCalls.set(idx, record);
        state.toolOrder.push(idx);
        state.outputItems.push({
          id: record.outputItemId, type: "function_call",
          call_id: record.id, name: record.name, arguments: "", status: "in_progress"
        });
        out += emitEvent("response.output_item.added", {
          output_index: state.outputItems.length - 1,
          item: { id: record.outputItemId, type: "function_call", call_id: record.id, name: record.name, arguments: "", status: "in_progress" }
        });
      }
      if (tc.function?.name && !record.name) record.name = tc.function.name;
      if (tc.id && record.id !== tc.id) record.id = tc.id;
      if (tc.function?.arguments) {
        record.arguments += tc.function.arguments;
        out += emitEvent("response.function_call_arguments.delta", {
          item_id: record.outputItemId,
          output_index: 0,
          delta: tc.function.arguments
        });
      }
    }

    if (e.usage) state.usage = e.usage;
    if (choice.finish_reason) {
      state.finishReason = choice.finish_reason;
      // Close any in-progress function_call items
      for (const idx of state.toolOrder) {
        const record = state.toolCalls.get(idx);
        if (record) {
          out += emitEvent("response.output_item.done", {
            output_index: 0,
            item: { id: record.outputItemId, type: "function_call", call_id: record.id, name: record.name, arguments: record.arguments, status: "completed" }
          });
        }
      }
      // Close text message item if open
      if (state.textOutputItemId) {
        out += emitEvent("response.output_item.done", {
          output_index: 0,
          item: { id: state.textOutputItemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: state.text }] }
        });
      }
      out += responseCompleted();
    }
    return out;
  };
}

function chatToMessagesEvents(originalRequest = {}) {
  // Translate Chat Completions SSE events -> Anthropic Messages SSE events.
  // Supports text and tool_calls deltas.
  const state = { messageId: null, model: null, blockIndex: 0, textBlockOpen: false, toolIndexMap: new Map() };
  function openTextBlock() {
    if (state.textBlockOpen) return "";
    state.textBlockOpen = true;
    return sseEvent("content_block_start", { type: "content_block_start", index: state.blockIndex, content_block: { type: "text", text: "" } });
  }
  function closeTextBlock() {
    if (!state.textBlockOpen) return "";
    state.textBlockOpen = false;
    const idx = state.blockIndex; state.blockIndex += 1;
    return sseEvent("content_block_stop", { type: "content_block_stop", index: idx });
  }
  function ensureMessageStart(e) {
    if (state.messageId) return "";
    state.messageId = e.id || `msg_${Math.random().toString(36).slice(2, 12)}`;
    state.model = e.model || originalRequest?.model || "";
    return sseEvent("message_start", {
      type: "message_start",
      message: { id: state.messageId, type: "message", role: "assistant", model: state.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
    });
  }
  return function(event) {
    if (!event || event.data == null || event.data === "[DONE]") {
      if (event && event.data === "[DONE]") {
        return closeTextBlock() + sseEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { input_tokens: 0, output_tokens: 0 }
        }) + sseEvent("message_stop", { type: "message_stop" });
      }
      return "";
    }
    const e = event.data;
    const choice = e.choices?.[0];
    if (!choice) return "";
    const delta = choice.delta || choice.message || {};
    let out = ensureMessageStart(e);
    if (typeof delta.content === "string" && delta.content) {
      out += openTextBlock() + sseEvent("content_block_delta", { type: "content_block_delta", index: state.blockIndex, delta: { type: "text_delta", text: delta.content } });
    }
    // Tool calls
    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const tc of toolCalls) {
      const idx = tc.index ?? 0;
      let blockIdx = state.toolIndexMap.get(idx);
      if (blockIdx == null) {
        blockIdx = state.blockIndex; state.blockIndex += 1;
        state.toolIndexMap.set(idx, blockIdx);
        out += sseEvent("content_block_start", {
          type: "content_block_start", index: blockIdx,
          content_block: { type: "tool_use", id: tc.id || `toolu_${Math.random().toString(36).slice(2, 10)}`, name: tc.function?.name || "", input: {} }
        });
      }
      if (tc.function?.arguments) {
        out += sseEvent("content_block_delta", {
          type: "content_block_delta", index: blockIdx,
          delta: { type: "input_json_delta", partial_json: tc.function.arguments }
        });
      }
    }
    if (choice.finish_reason) {
      out += closeTextBlock() + sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: choice.finish_reason === "length" ? "max_tokens" : choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn", stop_sequence: null },
        usage: e.usage ? { input_tokens: e.usage.prompt_tokens || 0, output_tokens: e.usage.completion_tokens || 0 } : { input_tokens: 0, output_tokens: 0 }
      }) + sseEvent("message_stop", { type: "message_stop" });
    }
    return out;
  };
}

function messagesEvents() {
  // Translate Anthropic Messages SSE events -> Responses SSE events.
  // Supports text and tool_use blocks (Anthropic content_block type=tool_use).
  const state = { responseId: null, model: null, started: false, textItemId: null, text: "", usage: { input_tokens: 0, output_tokens: 0 }, stopReason: null, outputItems: [], toolBlocks: new Map(), toolItemIndex: 0 };
  function emitEvent(type, payload) { return sseData({ type, ...payload }); }
  function ensureStarted(message) {
    if (state.started) return "";
    state.started = true;
    state.responseId = message.id || `resp_${Math.random().toString(36).slice(2, 12)}`;
    state.model = message.model || state.model;
    return emitEvent("response.created", {
      response: { id: state.responseId, object: "response", status: "in_progress", model: state.model, output: [] }
    });
  }
  function ensureTextItem() {
    if (state.textItemId) return state.textItemId;
    const id = `msg_${Math.random().toString(36).slice(2, 10)}`;
    state.textItemId = id;
    state.outputItems.push({ id, type: "message", role: "assistant", status: "in_progress", content: [] });
    return id;
  }
  function responseCompleted() {
    return emitEvent("response.completed", {
      response: {
        id: state.responseId, object: "response", status: "completed", model: state.model || "unknown",
        output: state.outputItems,
        usage: state.usage,
        stop_reason: state.stopReason === "max_tokens" ? "max_output_tokens" : state.stopReason === "tool_use" ? "tool_use" : "end_turn"
      }
    });
  }
  return function(event) {
    if (!event || event.data == null || event.data === "[DONE]") return "";
    const e = event.data;
    const type = e.type || event.eventName;
    if (type === "message_start") {
      return ensureStarted(e.message || {});
    }
    if (type === "content_block_start") {
      const block = e.content_block || {};
      if (block.type === "tool_use") {
        const itemId = `fc_${Math.random().toString(36).slice(2, 10)}`;
        state.toolBlocks.set(block.id, { itemId, name: block.name || "", arguments: "" });
        state.outputItems.push({
          id: itemId, type: "function_call",
          call_id: block.id, name: block.name || "", arguments: "", status: "in_progress"
        });
        state.toolItemIndex = state.outputItems.length - 1;
        return emitEvent("response.output_item.added", {
          output_index: state.toolItemIndex,
          item: { id: itemId, type: "function_call", call_id: block.id, name: block.name || "", arguments: "", status: "in_progress" }
        });
      }
      // Text block — ensure text output item exists
      const msgId = ensureTextItem();
      return emitEvent("response.output_item.added", {
        output_index: state.outputItems.length - 1,
        item: { id: msgId, type: "message", role: "assistant", status: "in_progress", content: [] }
      });
    }
    if (type === "content_block_delta") {
      if (e.delta?.type === "text_delta" && e.delta.text) {
        state.text += e.delta.text;
        const msgId = ensureTextItem();
        return emitEvent("response.output_text.delta", { item_id: msgId, output_index: 0, content_index: 0, delta: e.delta.text });
      }
      if (e.delta?.type === "input_json_delta" && e.delta.partial_json) {
        // Find the most recent tool_use block
        const last = Array.from(state.toolBlocks.values()).pop();
        if (last) {
          last.arguments += e.delta.partial_json;
          return emitEvent("response.function_call_arguments.delta", {
            item_id: last.itemId, output_index: 0, delta: e.delta.partial_json
          });
        }
      }
      return "";
    }
    if (type === "content_block_stop") {
      return ""; // block close is implicit on response.completed
    }
    if (type === "message_delta") {
      if (e.usage) state.usage = { ...state.usage, ...e.usage };
      if (e.delta?.stop_reason) state.stopReason = e.delta.stop_reason;
      return "";
    }
    if (type === "message_stop") {
      return responseCompleted();
    }
    return "";
  };
}

function messagesToChatEvents() {
  // Translate Anthropic Messages SSE events -> Chat Completions SSE events.
  // Supports text and tool_use blocks.
  const state = { model: null, messageId: null, started: false, text: "", finishReason: null, usage: {}, toolIndex: 0, toolSeen: new Map() };
  function chatChunk(delta, finishReason) {
    return sseData({
      id: state.messageId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: state.model || "unknown",
      choices: [{ index: 0, delta, finish_reason: finishReason || null }]
    });
  }
  return function(event) {
    if (!event || event.data == null || event.data === "[DONE]") return "";
    const e = event.data;
    const type = e.type || event.eventName;
    if (type === "message_start") {
      state.model = e.message?.model || state.model;
      state.messageId = e.message?.id;
      state.started = true;
      return chatChunk({ role: "assistant", content: "" });
    }
    if (type === "content_block_start") {
      const block = e.content_block || {};
      if (block.type === "tool_use") {
        const idx = state.toolIndex;
        const tc = { index: idx, id: block.id || `toolu_${Math.random().toString(36).slice(2, 10)}`, type: "function", function: { name: block.name || "", arguments: "" } };
        state.toolSeen.set(block.id, tc);
        state.toolIndex += 1;
        return chatChunk({ tool_calls: [tc] });
      }
      return "";
    }
    if (type === "content_block_delta") {
      if (e.delta?.text) {
        state.text += e.delta.text;
        return chatChunk({ content: e.delta.text });
      }
      if (e.delta?.partial_json) {
        // Find the most recently opened tool_use block
        const last = Array.from(state.toolSeen.values()).pop();
        if (last) {
          last.function.arguments += e.delta.partial_json;
          return chatChunk({ tool_calls: [{ index: last.index, function: { arguments: e.delta.partial_json } }] });
        }
      }
      return "";
    }
    if (type === "message_delta") {
      if (e.delta?.stop_reason) state.finishReason = e.delta.stop_reason;
      if (e.usage) state.usage = { ...state.usage, ...e.usage };
      return "";
    }
    if (type === "message_stop") {
      const reason = state.finishReason === "max_tokens" ? "length"
        : state.finishReason === "tool_use" ? "tool_calls"
        : "stop";
      const out = chatChunk({}, reason);
      if (state.usage && Object.keys(state.usage).length) {
        out += sseData({
          id: state.messageId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: state.model || "unknown",
          choices: [],
          usage: {
            prompt_tokens: state.usage.input_tokens || 0,
            completion_tokens: state.usage.output_tokens || 0,
            total_tokens: (state.usage.input_tokens || 0) + (state.usage.output_tokens || 0)
          }
        });
      }
      return out + sseDone();
    }
    return "";
  };
}

const SSE_TRANSLATORS = {
  // The key is "clientShape:upstreamShape" -- the client sent in clientShape,
  // the upstream responded in upstreamShape, so we translate upstreamShape
  // events back to clientShape events for the client to consume.
  [`${WIRE_SHAPES.RESPONSES}:${WIRE_SHAPES.CHAT_COMPLETIONS}`]: chatEvents,
  [`${WIRE_SHAPES.RESPONSES}:${WIRE_SHAPES.MESSAGES}`]: messagesEvents,
  [`${WIRE_SHAPES.CHAT_COMPLETIONS}:${WIRE_SHAPES.RESPONSES}`]: responsesEvents,
  [`${WIRE_SHAPES.CHAT_COMPLETIONS}:${WIRE_SHAPES.MESSAGES}`]: messagesToChatEvents,
  [`${WIRE_SHAPES.MESSAGES}:${WIRE_SHAPES.RESPONSES}`]: responsesToMessagesEvents,
  [`${WIRE_SHAPES.MESSAGES}:${WIRE_SHAPES.CHAT_COMPLETIONS}`]: chatToMessagesEvents
};

export function createShapeSseTransformStream(bridge) {
  if (!bridge || !bridge.sourceShape || !bridge.targetShape) return null;
  const sourceShape = bridge.sourceShape;
  const targetShape = bridge.targetShape;
  if (sourceShape === targetShape) return null;
  if (targetShape === WIRE_SHAPES.ANTIGRAVITY) return createAntigravitySseTransformStream(bridge);
  const factory = SSE_TRANSLATORS[`${sourceShape}:${targetShape}`];
  if (!factory) return null;
  const inner = factory(bridge.originalRequest || {});
  if (!inner) return null;
  // If the factory already returned a Transform (chat -> responses), use it directly.
  if (typeof inner.pipe === "function" && typeof inner.read === "function") return inner;
  // Otherwise wrap a stateful event-collector in a Transform.
  let buffer = "";
  return new Transform({
    transform(chunk, encoding, callback) {
      buffer += chunk.toString("utf8");
      let boundary;
      while ((boundary = nextSseBoundary(buffer)) != null) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const event = parseSseFrame(frame);
        console.log(`[DEBUG sse transform] frameLen=${frame.length}, eventData=${event?.data?.choices?.[0]?.delta?.content || event?.data?.type || 'null'}`);
        if (event == null) continue;
        const out = inner(event);
        console.log(`[DEBUG sse transform] outLen=${out?.length || 0}`);
        if (out) this.push(sseBytes(out));
      }
      callback();
    },
    flush(callback) {
      if (buffer.trim()) {
        const event = parseSseFrame(buffer);
        if (event) {
          const out = inner(event);
          if (out) this.push(sseBytes(out));
        }
      }
      callback();
    }
  });
}

export const SHAPE_SSE_SUPPORTED = Object.freeze(Object.keys(SSE_TRANSLATORS));
