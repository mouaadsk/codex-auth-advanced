import { Transform } from "node:stream";
import { ensureEncryptedContent } from "./proxy-body-transforms.mjs";
import { normalizeCompactionResponse } from "./proxy-compaction.mjs";

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
