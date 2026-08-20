import { Transform } from "node:stream";
import {
  ClaudeResponsesStreamState,
  nextSseBoundary,
  parseSseData
} from "./claude-responses-core.mjs";

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
