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
import { Transform } from "node:stream";
import {
  prepareAntigravityBridge,
  retargetAntigravityBridge,
  translateAntigravityResponseToShape,
  createAntigravitySseTransformStream
} from "./antigravity-bridge.mjs";
import { createChatToResponsesSseTransformStream } from "./chat-responses-bridge.mjs";

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
  const state = { responseId: null, model: null, outputItemId: null, text: "", started: false, usage: {}, finishReason: null };
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
      return sseData({
        id: state.responseId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: state.model || "unknown",
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]
      });
    }
    if (e.type === "response.output_text.delta" && e.delta) {
      return sseData({
        id: state.responseId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: state.model || "unknown",
        choices: [{ index: 0, delta: { content: e.delta }, finish_reason: null }]
      });
    }
    if (e.type === "response.completed" || e.type === "response.incomplete") {
      const response = e.response || {};
      const finishReason = response.stop_reason === "max_output_tokens" ? "length" : "stop";
      return sseData({
        id: response.id || state.responseId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: response.model || state.model || "unknown",
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        usage: response.usage ? {
          prompt_tokens: response.usage.input_tokens || 0,
          completion_tokens: response.usage.output_tokens || 0,
          total_tokens: response.usage.total_tokens || 0
        } : undefined
      }) + sseDone();
    }
    return "";
  };
}

function responsesToMessagesEvents(originalRequest = {}) {
  const state = { messageId: null, model: null, blockIndex: 0, textBlockOpen: false, finishReason: null };
  function openTextBlock() {
    if (state.textBlockOpen) return "";
    state.textBlockOpen = true;
    return sseEvent("content_block_start", {
      type: "content_block_start",
      index: state.blockIndex,
      content_block: { type: "text", text: "" }
    });
  }
  function closeTextBlock() {
    if (!state.textBlockOpen) return "";
    state.textBlockOpen = false;
    const idx = state.blockIndex;
    state.blockIndex += 1;
    return sseEvent("content_block_stop", { type: "content_block_stop", index: idx });
  }
  return function(event) {
    if (!event || event.data == null || event.data === "[DONE]") return "";
    const e = event.data;
    if (e.type === "response.created" && e.response) {
      state.messageId = e.response.id;
      state.model = e.response.model || originalRequest?.model || "";
      return sseEvent("message_start", {
        type: "message_start",
        message: {
          id: state.messageId,
          type: "message",
          role: "assistant",
          model: state.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      });
    }
    if (e.type === "response.output_text.delta" && e.delta) {
      return openTextBlock() + sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: state.blockIndex,
        delta: { type: "text_delta", text: e.delta }
      });
    }
    if (e.type === "response.completed" || e.type === "response.incomplete") {
      const response = e.response || {};
      state.finishReason = response.stop_reason === "max_output_tokens" ? "max_tokens" : "end_turn";
      return closeTextBlock() + sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: state.finishReason, stop_sequence: null },
        usage: response.usage || { input_tokens: 0, output_tokens: 0 }
      }) + sseEvent("message_stop", { type: "message_stop" });
    }
    return "";
  };
}

function chatEvents() {
  // Translate Chat Completions SSE events -> Responses SSE events.
  const state = { responseId: null, model: null, outputItemId: null, started: false, text: "", usage: {}, finishReason: null };
  function emitEvent(type, payload) { return sseData({ type, ...payload }); }
  return function(event) {
    if (!event || event.data == null || event.data === "[DONE]") {
      // [DONE] emits response.completed in responses style
      if (event && event.data === "[DONE]" && state.started) {
        return emitEvent("response.completed", {
          response: {
            id: state.responseId, object: "response", status: "completed",
            model: state.model || "unknown",
            output: [{ id: state.outputItemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: state.text }] }],
            usage: { input_tokens: Number(state.usage.prompt_tokens) || 0, output_tokens: Number(state.usage.completion_tokens) || 0, total_tokens: Number(state.usage.total_tokens) || 0 },
            stop_reason: state.finishReason === "length" ? "max_output_tokens" : "end_turn"
          }
        });
      }
      return "";
    }
    const e = event.data;
    const choice = e.choices?.[0];
    if (!choice) {
      if (e.usage) state.usage = e.usage;
      return "";
    }
    const delta = choice.delta || choice.message || {};
    if (!state.started) {
      state.started = true;
      state.responseId = e.id || `resp_${Math.random().toString(36).slice(2, 12)}`;
      state.model = e.model || state.model;
      state.outputItemId = `msg_${Math.random().toString(36).slice(2, 10)}`;
      let out = emitEvent("response.created", {
        response: { id: state.responseId, object: "response", status: "in_progress", model: state.model, output: [] }
      });
      out += emitEvent("response.output_item.added", {
        output_index: 0,
        item: { id: state.outputItemId, type: "message", role: "assistant", status: "in_progress", content: [] }
      });
      if (typeof delta.content === "string" && delta.content) {
        state.text += delta.content;
        out += emitEvent("response.output_text.delta", { item_id: state.outputItemId, output_index: 0, content_index: 0, delta: delta.content });
      }
      return out;
    }
    let out = "";
    if (typeof delta.content === "string" && delta.content) {
      state.text += delta.content;
      out += emitEvent("response.output_text.delta", { item_id: state.outputItemId, output_index: 0, content_index: 0, delta: delta.content });
    }
    if (e.usage) state.usage = e.usage;
    if (choice.finish_reason) {
      state.finishReason = choice.finish_reason;
      out += emitEvent("response.output_item.done", {
        output_index: 0,
        item: { id: state.outputItemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: state.text }] }
      });
      out += emitEvent("response.completed", {
        response: {
          id: state.responseId, object: "response", status: "completed", model: state.model || "unknown",
          output: [{ id: state.outputItemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: state.text }] }],
          usage: { input_tokens: Number(state.usage.prompt_tokens) || 0, output_tokens: Number(state.usage.completion_tokens) || 0, total_tokens: Number(state.usage.total_tokens) || 0 },
          stop_reason: state.finishReason === "length" ? "max_output_tokens" : "end_turn"
        }
      });
    }
    return out;
  };
}

function chatToMessagesEvents(originalRequest = {}) {
  const state = { messageId: null, model: null, blockIndex: 0, textBlockOpen: false };
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
    let out = "";
    if (!state.messageId) {
      state.messageId = e.id || `msg_${Math.random().toString(36).slice(2, 12)}`;
      state.model = e.model || originalRequest?.model || "";
      out += sseEvent("message_start", {
        type: "message_start",
        message: { id: state.messageId, type: "message", role: "assistant", model: state.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
      });
    }
    if (typeof delta.content === "string" && delta.content) {
      out += openTextBlock() + sseEvent("content_block_delta", { type: "content_block_delta", index: state.blockIndex, delta: { type: "text_delta", text: delta.content } });
    }
    if (choice.finish_reason) {
      out += closeTextBlock() + sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: choice.finish_reason === "length" ? "max_tokens" : "end_turn", stop_sequence: null },
        usage: e.usage ? { input_tokens: e.usage.prompt_tokens || 0, output_tokens: e.usage.completion_tokens || 0 } : { input_tokens: 0, output_tokens: 0 }
      }) + sseEvent("message_stop", { type: "message_stop" });
    }
    return out;
  };
}

function messagesEvents() {
  // Translate Anthropic Messages SSE events -> Responses SSE events.
  const state = { responseId: null, model: null, outputItemId: null, text: "", started: false, usage: { input_tokens: 0, output_tokens: 0 }, stopReason: null };
  function emitEvent(type, payload) { return sseData({ type, ...payload }); }
  let pendingTextBlock = false;
  return function(event) {
    if (!event || event.data == null || event.data === "[DONE]") return "";
    const e = event.data;
    const type = e.type || event.eventName;
    if (type === "message_start") {
      state.responseId = e.message?.id || `resp_${Math.random().toString(36).slice(2, 12)}`;
      state.model = e.message?.model || state.model;
      return emitEvent("response.created", {
        response: { id: state.responseId, object: "response", status: "in_progress", model: state.model, output: [] }
      });
    }
    if (type === "content_block_start") {
      if (!state.started) {
        state.started = true;
        state.outputItemId = e.content_block?.id || `msg_${Math.random().toString(36).slice(2, 10)}`;
        return emitEvent("response.output_item.added", {
          output_index: 0,
          item: { id: state.outputItemId, type: "message", role: "assistant", status: "in_progress", content: [] }
        }) + emitEvent("response.output_text.delta", { item_id: state.outputItemId, output_index: 0, content_index: 0, delta: "" });
      }
      return "";
    }
    if (type === "content_block_delta") {
      const text = e.delta?.text || "";
      if (text) {
        state.text += text;
        return emitEvent("response.output_text.delta", { item_id: state.outputItemId, output_index: 0, content_index: 0, delta: text });
      }
      return "";
    }
    if (type === "message_delta") {
      if (e.usage) state.usage = { ...state.usage, ...e.usage };
      if (e.delta?.stop_reason) state.stopReason = e.delta.stop_reason;
      return "";
    }
    if (type === "message_stop") {
      return emitEvent("response.completed", {
        response: {
          id: state.responseId, object: "response", status: "completed", model: state.model || "unknown",
          output: [{ id: state.outputItemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: state.text }] }],
          usage: state.usage,
          stop_reason: state.stopReason === "max_tokens" ? "max_output_tokens" : "end_turn"
        }
      });
    }
    return "";
  };
}

function messagesToChatEvents() {
  const state = { model: null, text: "", started: false, finishReason: null, usage: {} };
  return function(event) {
    if (!event || event.data == null || event.data === "[DONE]") return "";
    const e = event.data;
    const type = e.type || event.eventName;
    if (type === "message_start") {
      state.model = e.message?.model || state.model;
      return sseData({
        id: e.message?.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: state.model || "unknown",
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]
      });
    }
    if (type === "content_block_delta" && e.delta?.text) {
      state.text += e.delta.text;
      return sseData({
        id: e.message?.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: state.model || "unknown",
        choices: [{ index: 0, delta: { content: e.delta.text }, finish_reason: null }]
      });
    }
    if (type === "message_delta") {
      if (e.delta?.stop_reason) state.finishReason = e.delta.stop_reason;
      if (e.usage) state.usage = { ...state.usage, ...e.usage };
      return "";
    }
    if (type === "message_stop") {
      const reason = state.finishReason === "max_tokens" ? "length" : "stop";
      return sseData({
        id: e.message?.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: state.model || "unknown",
        choices: [{ index: 0, delta: {}, finish_reason: reason }],
        usage: state.usage && Object.keys(state.usage).length ? {
          prompt_tokens: state.usage.input_tokens || 0,
          completion_tokens: state.usage.output_tokens || 0,
          total_tokens: (state.usage.input_tokens || 0) + (state.usage.output_tokens || 0)
        } : undefined
      }) + sseDone();
    }
    return "";
  };
}

const SSE_TRANSLATORS = {
  [`${WIRE_SHAPES.RESPONSES}:${WIRE_SHAPES.CHAT_COMPLETIONS}`]: responsesEvents,
  [`${WIRE_SHAPES.RESPONSES}:${WIRE_SHAPES.MESSAGES}`]: responsesToMessagesEvents,
  [`${WIRE_SHAPES.CHAT_COMPLETIONS}:${WIRE_SHAPES.RESPONSES}`]: (orig) => createChatToResponsesSseTransformStream(orig),
  [`${WIRE_SHAPES.CHAT_COMPLETIONS}:${WIRE_SHAPES.MESSAGES}`]: chatToMessagesEvents,
  [`${WIRE_SHAPES.MESSAGES}:${WIRE_SHAPES.RESPONSES}`]: messagesEvents,
  [`${WIRE_SHAPES.MESSAGES}:${WIRE_SHAPES.CHAT_COMPLETIONS}`]: messagesToChatEvents
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
        if (event == null) continue;
        const out = inner(event);
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
