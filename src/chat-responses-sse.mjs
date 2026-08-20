import { Transform } from "node:stream";
import { parseSseData, translateResponseObjectToChat } from "./chat-responses-core.mjs";

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
