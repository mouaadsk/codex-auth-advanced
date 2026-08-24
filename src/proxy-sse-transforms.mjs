import { Transform } from "node:stream";
import { ensureEncryptedContent } from "./proxy-body-transforms.mjs";
import { normalizeCompactionResponse } from "./proxy-compaction.mjs";
import { isModelCapacityResponseBody } from "./provider-policy.mjs";

const defaultCapacityPreludeTimeoutMs = 3000;
const defaultCapacityPreludeMaxBytes = 16 * 1024 * 1024;

function sseFrame(frame) {
  let event = "";
  const data = [];
  for (const rawLine of String(frame || "").split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(":")) continue;
    const separator = rawLine.indexOf(":");
    const field = separator < 0 ? rawLine : rawLine.slice(0, separator);
    let value = separator < 0 ? "" : rawLine.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value.trim();
    if (field === "data") data.push(value);
  }
  const dataText = data.join("\n").trim();
  if (!dataText) return { event, dataText, payload: null };
  if (dataText === "[DONE]") return { event, dataText, payload: null };
  try {
    return { event, dataText, payload: JSON.parse(dataText) };
  } catch {
    return { event, dataText, payload: null };
  }
}

function normalizedSseEventTypes(event, payload) {
  return [event, payload?.type, payload?.event]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim().toLowerCase());
}

function isTerminalFailureSseEvent(event, payload) {
  const types = normalizedSseEventTypes(event, payload);
  if (types.some((type) => type === "error" || type.endsWith(".failed") || type.endsWith("_error"))) {
    return true;
  }
  return payload?.status === "failed"
    || payload?.response?.status === "failed"
    || (payload?.error && typeof payload.error === "object")
    || (payload?.response?.error && typeof payload.response.error === "object");
}

function isTerminalSuccessSseEvent(event, payload, dataText) {
  if (dataText === "[DONE]") return true;
  const types = normalizedSseEventTypes(event, payload);
  if (types.some((type) => type === "response.completed" || type === "message_stop" || type === "message.stop")) {
    return true;
  }
  if (payload?.status === "completed" || payload?.response?.status === "completed") return true;
  return Array.isArray(payload?.choices)
    && payload.choices.length > 0
    && payload.choices.every((choice) => choice?.finish_reason != null);
}

function nonEmptyGeneratedValue(value) {
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value != null && typeof value === "object" && Object.keys(value).length > 0;
}

function responseItemHasGeneratedOutput(item) {
  if (!item || typeof item !== "object") return false;
  const type = String(item.type || "").toLowerCase();
  if (/(?:tool|function|computer|search|code_interpreter|mcp).*call|call$/.test(type)) return true;
  if (nonEmptyGeneratedValue(item.arguments) || nonEmptyGeneratedValue(item.input)) return true;
  if (Array.isArray(item.content)) {
    return item.content.some((part) => nonEmptyGeneratedValue(part?.text)
      || nonEmptyGeneratedValue(part?.content)
      || nonEmptyGeneratedValue(part?.arguments)
      || nonEmptyGeneratedValue(part?.input));
  }
  if (Array.isArray(item.summary)) {
    return item.summary.some((part) => nonEmptyGeneratedValue(part?.text));
  }
  return nonEmptyGeneratedValue(item.text) || nonEmptyGeneratedValue(item.content);
}

function chatChoiceHasGeneratedOutput(choice) {
  const delta = choice?.delta || choice?.message;
  if (!delta || typeof delta !== "object") return false;
  return nonEmptyGeneratedValue(delta.content)
    || nonEmptyGeneratedValue(delta.reasoning)
    || nonEmptyGeneratedValue(delta.reasoning_content)
    || nonEmptyGeneratedValue(delta.reasoning_details)
    || nonEmptyGeneratedValue(delta.tool_calls)
    || nonEmptyGeneratedValue(delta.function_call)
    || nonEmptyGeneratedValue(delta.audio);
}

function geminiCandidateHasGeneratedOutput(candidate) {
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) return false;
  return parts.some((part) => nonEmptyGeneratedValue(part?.text)
    || nonEmptyGeneratedValue(part?.thought)
    || nonEmptyGeneratedValue(part?.functionCall)
    || nonEmptyGeneratedValue(part?.functionResponse)
    || nonEmptyGeneratedValue(part?.inlineData));
}

function hasMeaningfulSseOutput(event, payload) {
  const types = normalizedSseEventTypes(event, payload);
  if (types.some((type) => /(?:output_text|refusal|reasoning(?:_summary)?_text|function_call_arguments|custom_tool_call_input|tool_call.*(?:input|arguments))\.(?:delta|done)$/.test(type))) {
    return true;
  }
  if (types.some((type) => /(?:content_block_(?:start|delta)|content\.delta)$/.test(type))) {
    const delta = payload?.delta || payload?.content_block || payload?.contentBlock;
    return nonEmptyGeneratedValue(delta?.text)
      || nonEmptyGeneratedValue(delta?.thinking)
      || nonEmptyGeneratedValue(delta?.partial_json)
      || nonEmptyGeneratedValue(delta?.input)
      || /tool_use|thinking|redacted_thinking/i.test(String(delta?.type || ""));
  }
  if (types.some((type) => /response\.output_item\.(?:added|done)$/.test(type))
    && responseItemHasGeneratedOutput(payload?.item)) {
    return true;
  }
  if (Array.isArray(payload?.choices) && payload.choices.some(chatChoiceHasGeneratedOutput)) return true;
  if (Array.isArray(payload?.candidates) && payload.candidates.some(geminiCandidateHasGeneratedOutput)) return true;
  return false;
}

function ssePreludeDecision(frame) {
  const parsed = sseFrame(frame);
  if (isTerminalFailureSseEvent(parsed.event, parsed.payload)
    && isModelCapacityResponseBody(parsed.payload || parsed.dataText)) {
    return "model_capacity";
  }
  if (hasMeaningfulSseOutput(parsed.event, parsed.payload)) return "output_started";
  if (isTerminalFailureSseEvent(parsed.event, parsed.payload)
    || isTerminalSuccessSseEvent(parsed.event, parsed.payload, parsed.dataText)) {
    return "terminal";
  }
  return null;
}

function nextSseFrameBoundary(buffer) {
  const match = /\r?\n\r?\n/.exec(buffer);
  if (!match) return null;
  return { index: match.index, length: match[0].length };
}

function cancelInspectionReader(reader, reason) {
  try {
    Promise.resolve(reader.cancel(reason)).catch(() => {});
  } catch {
    // The inspection clone may already be closed; the original stays intact.
  }
}

// New API-compatible providers can return HTTP 200, open an SSE stream, and
// only then report `server_overloaded`. Inspect a short clone of the stream so
// the proxy can retry before any bytes reach the client. The original response
// remains untouched and is used verbatim as soon as real text/reasoning/tool
// output starts, the stream terminates normally, or the inspection budget ends.
export async function inspectSsePreludeForModelCapacity(response, options = {}) {
  const contentType = String(response?.headers?.get?.("content-type") || "").toLowerCase();
  if (!response?.body
    || Number(response.status) < 200
    || Number(response.status) >= 300
    || !contentType.includes("event-stream")) {
    return { response, modelCapacity: false, outcome: "not_sse" };
  }

  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? defaultCapacityPreludeTimeoutMs) || 0);
  if (timeoutMs === 0) return { response, modelCapacity: false, outcome: "disabled" };
  const maxBytes = Math.max(1, Number(options.maxBytes ?? defaultCapacityPreludeMaxBytes) || defaultCapacityPreludeMaxBytes);

  let inspection;
  try {
    inspection = response.clone();
  } catch {
    return { response, modelCapacity: false, outcome: "unavailable" };
  }
  const reader = inspection.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  const timeoutToken = Symbol("capacity-prelude-timeout");
  let buffer = "";
  let bytesRead = 0;

  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      cancelInspectionReader(reader, "capacity prelude timeout");
      return { response, modelCapacity: false, outcome: "timeout" };
    }

    let timer = null;
    const read = reader.read();
    const result = await Promise.race([
      read,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(timeoutToken), remainingMs);
      })
    ]);
    if (timer) clearTimeout(timer);
    if (result === timeoutToken) {
      cancelInspectionReader(reader, "capacity prelude timeout");
      return { response, modelCapacity: false, outcome: "timeout" };
    }

    if (result.done) {
      buffer += decoder.decode();
      if (buffer.trim()) {
        const decision = ssePreludeDecision(buffer);
        if (decision === "model_capacity") {
          return { response, modelCapacity: true, outcome: decision };
        }
      }
      return { response, modelCapacity: false, outcome: "end" };
    }

    bytesRead += result.value.byteLength;
    if (bytesRead > maxBytes) {
      cancelInspectionReader(reader, "capacity prelude byte limit");
      return { response, modelCapacity: false, outcome: "byte_limit" };
    }
    buffer += decoder.decode(result.value, { stream: true });

    while (true) {
      const boundary = nextSseFrameBoundary(buffer);
      if (!boundary) break;
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const decision = ssePreludeDecision(frame);
      if (!decision) continue;
      cancelInspectionReader(reader, `capacity prelude ${decision}`);
      return {
        response,
        modelCapacity: decision === "model_capacity",
        outcome: decision
      };
    }
  }
}

export function isResponsesProxyTarget(target) {
  try {
    const pathname = new URL(target.url).pathname.replace(/\/$/, "");
    return pathname.endsWith("/responses");
  } catch {
    return false;
  }
}

export function createStreamDiagnostics(target, reqUrl) {
  const startMs = Date.now();
  return {
    responsesTarget: isResponsesProxyTarget(target),
    completed: false,
    mark(value) {
      if (value?.type === "response.completed") this.completed = true;
    },
    finish(reason) {
      if (!this.responsesTarget) return;
      const elapsedMs = Date.now() - startMs;
      const host = (() => {
        try {
          return new URL(target.url).host;
        } catch {
          return "unknown";
        }
      })();
      console.log(`[Proxy Stream] ${reqUrl} host=${host} completed=${this.completed} reason=${reason} elapsed_ms=${elapsedMs}`);
    }
  };
}

function normalizedFallbackModel(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Some OpenAI-compatible Responses implementations omit `model` from the
// response object even though strict clients require it. Preserve an upstream
// value when present and otherwise recover the model from the request that
// produced the response.
export function ensureResponsesModel(value, fallbackModel) {
  const model = normalizedFallbackModel(fallbackModel);
  if (!model || !value || typeof value !== "object") return false;

  const response = value.object === "response"
    ? value
    : value.response && typeof value.response === "object"
      ? value.response
      : null;
  if (!response) return false;
  if (typeof response.model === "string" && response.model.trim()) return false;

  response.model = model;
  return true;
}

export function createSseResponseTransformStream(target, isEventStream, diagnostics = null, options = {}) {
  const fallbackModel = options?.fallbackModel;
  let buffer = "";
  return new Transform({
    transform(chunk, encoding, callback) {
      if (isEventStream) {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        let out = "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ")) {
            const jsonText = trimmed.slice(6).trim();
            if (jsonText && jsonText !== "[DONE]") {
              try {
                const parsed = JSON.parse(jsonText);
                diagnostics?.mark(parsed);
                normalizeCompactionResponse(parsed);
                ensureEncryptedContent(parsed);
                ensureResponsesModel(parsed, fallbackModel);
                out += `data: ${JSON.stringify(parsed)}\n`;
                continue;
              } catch {
                // Ignore and pass through original
              }
            }
          } else if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            try {
              const parsed = JSON.parse(trimmed);
              diagnostics?.mark(parsed);
              normalizeCompactionResponse(parsed);
              ensureEncryptedContent(parsed);
              ensureResponsesModel(parsed, fallbackModel);
              out += JSON.stringify(parsed) + "\n";
              continue;
            } catch {
              // Ignore and pass through original
            }
          }
          out += line + "\n";
        }
        if (out) {
          this.push(Buffer.from(out, "utf8"));
        }
        callback();
      } else {
        buffer += chunk.toString("utf8");
        callback();
      }
    },
    flush(callback) {
      if (isEventStream) {
        if (buffer) {
          let out = buffer;
          const trimmed = buffer.trim();
          if (trimmed.startsWith("data: ")) {
            const jsonText = trimmed.slice(6).trim();
            if (jsonText && jsonText !== "[DONE]") {
              try {
                const parsed = JSON.parse(jsonText);
                diagnostics?.mark(parsed);
                normalizeCompactionResponse(parsed);
                ensureEncryptedContent(parsed);
                ensureResponsesModel(parsed, fallbackModel);
                out = `data: ${JSON.stringify(parsed)}`;
              } catch {
                // Ignore
              }
            }
          } else if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            try {
              const parsed = JSON.parse(trimmed);
              diagnostics?.mark(parsed);
              normalizeCompactionResponse(parsed);
              ensureEncryptedContent(parsed);
              ensureResponsesModel(parsed, fallbackModel);
              out = JSON.stringify(parsed);
            } catch {
              // Ignore
            }
          }
          this.push(Buffer.from(out, "utf8"));
        }
        callback();
      } else {
        if (buffer) {
          let out = buffer;
          try {
            const parsed = JSON.parse(buffer);
            diagnostics?.mark(parsed);
            normalizeCompactionResponse(parsed);
            ensureEncryptedContent(parsed);
            ensureResponsesModel(parsed, fallbackModel);
            out = JSON.stringify(parsed);
          } catch (e) {
            console.error("[Proxy Transform] Failed to parse/normalize unary JSON response:", e.message);
          }
          this.push(Buffer.from(out, "utf8"));
        }
        callback();
      }
    }
  });
}
