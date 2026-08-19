// Antigravity (Gemini :generateContent) bridge.
//
// VSLLM exposes Antigravity as a per-model fallback endpoint shaped exactly
// like Google's Gemini API:
//
//   POST {base}/v1beta/models/{model}:generateContent        (non-stream)
//   POST {base}/v1beta/models/{model}:streamGenerateContent?alt=sse   (stream)
//
// The envelope used upstream (per CLIProxyAPI's translator) is wrapped:
//   { "project": "", "model": "...", "request": { ... geminiRequest } }
//
// On the way in, we accept any of three shapes:
//   * OpenAI Responses  (/v1/responses)
//   * Anthropic Messages (/v1/messages)
//   * OpenAI Chat Completions (/v1/chat/completions)
//
// and convert them to the Gemini request envelope. On the way out, we convert
// the Gemini response back to whichever shape the proxy caller expects. SSE
// streaming is supported via a Transform that emits Gemini chunks on the
// wire and translates them into the source shape.

import { Transform } from "node:stream";
import { translateChatCompletionsRequestToResponses, translateResponsesResponseToChat } from "./chat-responses-bridge.mjs";
import { translateClaudeMessagesRequestToResponses, translateResponsesResponseToClaude } from "./claude-responses-bridge.mjs";

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

function safeStringify(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizedUrlPath(target) {
  try {
    return new URL(target?.url || "").pathname.replace(/\/$/, "");
  } catch {
    return "";
  }
}

function isResponsesPath(target) {
  return normalizedUrlPath(target).endsWith("/responses")
    || normalizedUrlPath(target).endsWith("/responses/compact");
}

function isMessagesPath(target) {
  return normalizedUrlPath(target).endsWith("/messages");
}

function isChatCompletionsPath(target) {
  return normalizedUrlPath(target).endsWith("/chat/completions");
}

function detectSourceShape(target) {
  if (isResponsesPath(target)) return "responses";
  if (isMessagesPath(target)) return "messages";
  if (isChatCompletionsPath(target)) return "chat_completions";
  return null;
}

// ---------- Responses -> Gemini ----------

function responsesPartToGeminiPart(part) {
  if (!part || typeof part !== "object") return null;
  if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
    return { text: String(part.text || "") };
  }
  if (part.type === "input_image") {
    const url = String(part.image_url || "");
    if (url.startsWith("data:")) {
      const match = url.match(/^data:([^;]+);base64,(.*)$/);
      if (match) return { inlineData: { mimeType: match[1], data: match[2] } };
    }
    return { fileData: { fileUri: url, mimeType: "image/png" } };
  }
  if (part.type === "input_file") {
    if (typeof part.file_data === "string" && part.file_data.startsWith("data:")) {
      const match = part.file_data.match(/^data:([^;]+);base64,(.*)$/);
      if (match) return { inlineData: { mimeType: match[1], data: match[2] } };
    }
    return { fileData: { fileUri: part.file_data || "", mimeType: "application/octet-stream" } };
  }
  if (typeof part.text === "string") {
    return { text: part.text };
  }
  return null;
}

function responsesContentToGeminiParts(content) {
  if (content == null) return [];
  if (typeof content === "string") return [{ text: content }];
  const out = [];
  for (const part of asArray(content)) {
    const translated = responsesPartToGeminiPart(part);
    if (translated) out.push(translated);
  }
  return out;
}

function responsesInputToGeminiContents(input) {
  const out = [];
  for (const item of asArray(input)) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "message") {
      const role = item.role === "assistant" ? "model" : "user";
      const parts = responsesContentToGeminiParts(item.content);
      if (parts.length) out.push({ role, parts });
      continue;
    }
    if (item.type === "function_call") {
      let args = {};
      try { args = item.arguments ? JSON.parse(item.arguments) : {}; } catch { args = {}; }
      out.push({
        role: "model",
        parts: [{
          functionCall: { name: item.name || "tool", args }
        }]
      });
      continue;
    }
    if (item.type === "function_call_output") {
      let output = item.output;
      if (typeof output === "string") {
        output = [{ text: output }];
      }
      out.push({
        role: "user",
        parts: [{
          functionResponse: {
            name: item.name || "tool",
            response: { output: typeof output === "string" ? output : safeStringify(output) }
          }
        }]
      });
      continue;
    }
    if (item.type === "reasoning") {
      // Reasoning items are not surfaced to Gemini; they are summarized if
      // present so the model can still see the gist of the prior chain.
      const summary = asArray(item.summary).map((s) => s?.text || "").filter(Boolean).join("\n");
      if (summary) {
        out.push({ role: "user", parts: [{ text: `[earlier reasoning]\n${summary}` }] });
      }
      continue;
    }
    if (item.type === "compaction") continue;
  }
  return out;
}

function responsesToolsToGeminiTools(tools) {
  const declarations = [];
  for (const tool of asArray(tools)) {
    if (!tool || typeof tool !== "object") continue;
    const name = String(tool.name || "tool");
    const description = String(tool.description || "");
    let parameters = tool.parameters || {};
    if (parameters && typeof parameters === "object") {
      parameters = { ...parameters };
      delete parameters.$schema;
      delete parameters.additionalProperties;
    }
    declarations.push({ name, description, parameters });
  }
  if (!declarations.length) return undefined;
  return [{ functionDeclarations: declarations }];
}

export function responsesToGeminiRequest(payload, modelOverride = null) {
  const source = payload && typeof payload === "object" ? payload : {};
  const model = modelOverride || source.model;
  const request = {
    contents: responsesInputToGeminiContents(source.input)
  };
  if (typeof source.instructions === "string" && source.instructions.trim()) {
    request.systemInstruction = { role: "system", parts: [{ text: source.instructions }] };
  }
  const tools = responsesToolsToGeminiTools(source.tools);
  if (tools) request.tools = tools;
  const generationConfig = {};
  if (Number.isFinite(Number(source.temperature))) generationConfig.temperature = Number(source.temperature);
  if (Number.isFinite(Number(source.top_p))) generationConfig.topP = Number(source.top_p);
  if (Number.isFinite(Number(source.max_output_tokens))) generationConfig.maxOutputTokens = Number(source.max_output_tokens);
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;
  return {
    project: "",
    model,
    request
  };
}

// ---------- Messages -> Gemini ----------

function claudeContentToGeminiParts(content) {
  if (content == null) return [];
  if (typeof content === "string") return [{ text: content }];
  const out = [];
  for (const part of asArray(content)) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" || part.type === undefined) {
      if (typeof part.text === "string") out.push({ text: part.text });
      continue;
    }
    if (part.type === "image") {
      const source = part.source || {};
      if (source.type === "base64" && source.data) {
        out.push({
          inlineData: { mimeType: source.media_type || "image/png", data: source.data }
        });
      } else if (source.type === "url" && source.url) {
        out.push({ fileData: { fileUri: source.url, mimeType: "image/png" } });
      }
      continue;
    }
    if (part.type === "tool_use") {
      out.push({
        functionCall: { name: part.name || "tool", args: part.input || {} }
      });
      continue;
    }
    if (part.type === "tool_result") {
      let content = part.content;
      if (typeof content === "string") {
        out.push({
          functionResponse: {
            name: part.name || "tool",
            response: { output: content }
          }
        });
      } else {
        out.push({
          functionResponse: {
            name: part.name || "tool",
            response: safeStringify(content)
          }
        });
      }
      continue;
    }
    if (part.type === "thinking") continue;
  }
  return out;
}

export function messagesToGeminiRequest(payload, modelOverride = null) {
  const source = payload && typeof payload === "object" ? payload : {};
  const model = modelOverride || source.model;
  const request = {
    contents: []
  };
  for (const message of asArray(source.messages)) {
    if (!message || typeof message !== "object") continue;
    const role = message.role === "assistant" ? "model" : "user";
    const parts = claudeContentToGeminiParts(message.content);
    if (parts.length) request.contents.push({ role, parts });
  }
  if (Array.isArray(source.system)) {
    const text = source.system
      .filter((part) => part && (part.type === "text" || part.type === undefined))
      .map((part) => String(part.text || ""))
      .filter(Boolean)
      .join("\n\n");
    if (text) request.systemInstruction = { role: "system", parts: [{ text }] };
  } else if (typeof source.system === "string" && source.system.trim()) {
    request.systemInstruction = { role: "system", parts: [{ text: source.system }] };
  }
  const declarations = [];
  for (const tool of asArray(source.tools)) {
    if (!tool || typeof tool !== "object") continue;
    let parameters = tool.input_schema || {};
    parameters = { ...parameters };
    delete parameters.$schema;
    delete parameters.additionalProperties;
    declarations.push({
      name: String(tool.name || "tool"),
      description: String(tool.description || ""),
      parameters
    });
  }
  if (declarations.length) request.tools = [{ functionDeclarations: declarations }];
  const generationConfig = {};
  if (Number.isFinite(Number(source.max_tokens))) generationConfig.maxOutputTokens = Number(source.max_tokens);
  if (Number.isFinite(Number(source.temperature))) generationConfig.temperature = Number(source.temperature);
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;
  return { project: "", model, request };
}

// ---------- Chat -> Gemini ----------

export function chatToGeminiRequest(payload, modelOverride = null) {
  const responsesShape = translateChatCompletionsRequestToResponses(payload || {});
  return responsesToGeminiRequest(responsesShape, modelOverride || responsesShape.model);
}

// ---------- Response: Gemini -> source shape ----------

function geminiPartsToText(parts) {
  return asArray(parts)
    .map((part) => part?.text || "")
    .filter(Boolean)
    .join("");
}

function geminiResponseToResponsesObject(payload) {
  const request = payload?.request || payload || {};
  const candidates = asArray(request.candidates);
  const first = candidates[0] || {};
  const content = first.content || {};
  const parts = asArray(content.parts);
  const text = geminiPartsToText(parts);
  const functionCalls = parts.filter((part) => isPlainObject(part?.functionCall));
  const output = [];
  if (text) output.push({
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }]
  });
  for (const part of functionCalls) {
    const fc = part.functionCall;
    output.push({
      type: "function_call",
      call_id: `call_${Math.random().toString(36).slice(2, 10)}`,
      name: fc.name || "tool",
      arguments: safeStringify(fc.args || {})
    });
  }
  const finishReason = first.finishReason === "STOP" ? "end_turn"
    : first.finishReason === "MAX_TOKENS" ? "max_output_tokens"
      : first.finishReason === "SAFETY" ? "content_filter"
        : "end_turn";
  return {
    id: `resp_${Math.random().toString(36).slice(2, 10)}`,
    object: "response",
    status: "completed",
    model: payload?.model || "unknown",
    output,
    usage: {
      input_tokens: Number(request.usageMetadata?.promptTokenCount) || 0,
      output_tokens: Number(request.usageMetadata?.candidatesTokenCount) || 0,
      total_tokens: Number(request.usageMetadata?.totalTokenCount) || 0
    },
    stop_reason: finishReason
  };
}

function geminiResponseToChat(payload) {
  const responsesObj = geminiResponseToResponsesObject(payload);
  return translateResponsesResponseToChat({
    type: "response.completed",
    response: responsesObj
  });
}

function geminiResponseToMessages(payload, originalRequest = {}) {
  const responsesObj = geminiResponseToResponsesObject(payload);
  return translateResponsesResponseToClaude({
    type: "response.completed",
    response: responsesObj
  }, originalRequest);
}

// ---------- URL builder ----------

function antigravityBaseUrl(account) {
  const candidates = [
    account?.antigravity_base_url,
    account?.antigravityBaseUrl,
    account?.gemini_base_url,
    account?.geminiBaseUrl
  ].filter(Boolean);
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.replace(/\/$/, "");
  }
  return null;
}

export function antigravityTargetForAccount(account, sourceShape, model) {
  const base = antigravityBaseUrl(account);
  if (!base) return null;
  const stream = sourceShape === "responses" || sourceShape === "messages" || sourceShape === "chat_completions";
  const streamFlag = account?.antigravity_stream ?? true;
  const useStream = streamFlag && stream;
  const path = useStream
    ? `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
    : `/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  return {
    account,
    apiKey: account?.apiKey || null,
    upstreamBaseUrl: base,
    url: `${base}${path}`,
    antigravityBridge: true,
    antigravityStream: useStream,
    antigravityModel: model
  };
}

export function prepareAntigravityBridge(target, body) {
  const sourceShape = detectSourceShape(target);
  if (!sourceShape) return null;
  const parsed = parseBody(body);
  if (!parsed) return null;

  let geminiBody;
  if (sourceShape === "responses") {
    geminiBody = responsesToGeminiRequest(parsed);
  } else if (sourceShape === "messages") {
    geminiBody = messagesToGeminiRequest(parsed);
  } else if (sourceShape === "chat_completions") {
    geminiBody = chatToGeminiRequest(parsed);
  } else {
    return null;
  }

  const ag = antigravityTargetForAccount(target.account, sourceShape, geminiBody.model);
  if (!ag) return null;
  return {
    kind: "antigravity",
    sourceShape,
    originalRequest: parsed,
    translatedRequest: geminiBody,
    target: ag,
    body: Buffer.from(safeStringify(geminiBody), "utf8")
  };
}

export function retargetAntigravityBridge(target, bridge) {
  if (!bridge) return target;
  if (bridge.kind !== "antigravity") return target;
  const model = bridge.translatedRequest?.model || target?.antigravityModel;
  return antigravityTargetForAccount(target.account, bridge.sourceShape, model);
}

// ---------- Response translators (public) ----------

export function translateAntigravityResponseToShape(payload, sourceShape, originalRequest = {}) {
  if (sourceShape === "responses") {
    const responsesObj = geminiResponseToResponsesObject(payload);
    return { kind: "responses", body: responsesObj };
  }
  if (sourceShape === "chat_completions") {
    return { kind: "chat_completions", body: geminiResponseToChat(payload) };
  }
  if (sourceShape === "messages") {
    return { kind: "messages", body: geminiResponseToMessages(payload, originalRequest) };
  }
  return null;
}

// ---------- Streaming helpers ----------

function nextSseBoundary(buffer) {
  const idx = buffer.indexOf("\n\n");
  if (idx === -1) return null;
  return { end: idx + 2, frame: buffer.slice(0, idx) };
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

function antigravityEvent(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function chatSseData(payload) {
  return `data: ${JSON.stringify({ object: "chat.completion.chunk", ...payload, object: "chat.completion.chunk" })}\n\n`;
}

function responsesSseData(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function messagesSseData(eventType, payload) {
  return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function createAntigravitySseTransformStream(bridge) {
  const sourceShape = bridge?.sourceShape || "responses";
  const originalRequest = bridge?.originalRequest || {};
  let buffer = "";
  let finalized = false;
  return new Transform({
    transform(chunk, encoding, callback) {
      buffer += chunk.toString("utf8");
      let boundary = nextSseBoundary(buffer);
      while (boundary) {
        const parsed = parseSseData(boundary.frame);
        if (parsed) {
          const responsesObj = geminiResponseToResponsesObject(parsed);
          if (sourceShape === "responses") {
            this.push(responsesSseData({
              type: "response.output_text.delta",
              delta: geminiPartsToText(responsesObj.output?.[0]?.content || [])
            }));
          } else if (sourceShape === "chat_completions") {
            const chat = geminiResponseToChat(parsed);
            if (chat) this.push(chatSseData(chat));
          } else if (sourceShape === "messages") {
            const msg = geminiResponseToMessages(parsed, originalRequest);
            if (msg) {
              this.push(messagesSseData("message_start", { type: "message_start", message: msg }));
              const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
              this.push(messagesSseData("content_block_delta", {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text }
              }));
              this.push(messagesSseData("message_stop", { type: "message_stop" }));
              finalized = true;
            }
          }
        }
        buffer = buffer.slice(boundary.end);
        boundary = nextSseBoundary(buffer);
      }
      callback();
    },
    flush(callback) {
      if (sourceShape === "responses") {
        this.push(responsesSseData({ type: "response.completed", response: { id: "resp_done", status: "completed" } }));
      } else if (sourceShape === "chat_completions" && !finalized) {
        this.push("data: [DONE]\n\n");
      } else if (sourceShape === "messages" && !finalized) {
        this.push("data: [DONE]\n\n");
      }
      callback();
    }
  });
}
