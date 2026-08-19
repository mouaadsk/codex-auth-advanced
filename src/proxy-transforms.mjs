import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import zlib from "node:zlib";
import {
  isVsllmApiAccount,
  remappedProxyRequestModel,
  resolvedClaudeGatewayModelId
} from "./provider-policy.mjs";

const dropProxyJsonValue = Symbol("dropProxyJsonValue");
const remoteCompactionV2SummaryPrefix = "codex-auth-advanced:remote-compaction-v2:";

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function decodeRemoteCompactionV2Summary(value) {
  if (typeof value !== "string" || !value.startsWith(remoteCompactionV2SummaryPrefix)) return null;
  try {
    const summary = Buffer.from(value.slice(remoteCompactionV2SummaryPrefix.length), "base64url").toString("utf8");
    return summary.trim() ? summary : null;
  } catch {
    return null;
  }
}

function encodeRemoteCompactionV2Summary(summary) {
  return `${remoteCompactionV2SummaryPrefix}${Buffer.from(String(summary || ""), "utf8").toString("base64url")}`;
}

function remoteCompactionV2SummaryMessage(summary) {
  return {
    type: "message",
    role: "developer",
    content: [{
      type: "input_text",
      text: `Context summary from an earlier compaction:\n\n${summary}`
    }]
  };
}

// A remote-v2 compaction item is opaque to Codex, but VSLLM cannot decrypt
// OpenAI's encrypted representation. Convert only summaries synthesized by
// this proxy back into normal context before they reach the provider.
function expandRemoteCompactionV2Summaries(parsed) {
  if (!Array.isArray(parsed?.input)) return false;
  let changed = false;
  parsed.input = parsed.input.map((item) => {
    const summary = item?.type === "compaction"
      ? decodeRemoteCompactionV2Summary(item.encrypted_content)
      : null;
    if (!summary) return item;
    changed = true;
    return remoteCompactionV2SummaryMessage(summary);
  });
  return changed;
}

function parseTurnMetadata(value) {
  if (isPlainObject(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasRemoteCompactionV2Metadata(parsed, headers) {
  const metadataValues = [
    parsed?.client_metadata?.["x-codex-turn-metadata"],
    parsed?.client_metadata?.x_codex_turn_metadata,
    headers?.["x-codex-turn-metadata"],
    headers?.["X-Codex-Turn-Metadata"]
  ];
  return metadataValues.some((value) => {
    const metadata = parseTurnMetadata(value);
    return metadata?.request_kind === "compaction"
      && metadata?.compaction?.implementation === "responses_compaction_v2";
  });
}

// Codex sends remote compaction v2 through the ordinary /responses endpoint.
// The explicit input control is the canonical marker; the metadata check keeps
// the proxy compatible with equivalent future request layouts.
export function isCodexRemoteCompactionV2Request(target, parsed, headers = {}) {
  if (!isResponsesProxyTarget(target) || !isPlainObject(parsed)) return false;
  const hasTrigger = Array.isArray(parsed.input)
    && parsed.input.some((item) => item?.type === "compaction_trigger");
  return hasTrigger || hasRemoteCompactionV2Metadata(parsed, headers);
}

function isEncryptedContentKey(key) {
  return String(key || "").replaceAll(/[_-]/g, "").toLowerCase() === "encryptedcontent";
}

function shouldDropAfterEncryptedContentRemoval(value) {
  if (!value || typeof value !== "object") return false;
  if (value.type === "message" && value.role !== "user" && value.content === undefined) return true;
  return false;
}

function sanitizePlaintextContentPart(part) {
  if (!part || typeof part !== "object") return part;
  const type = typeof part.type === "string" ? part.type : "";
  if (type === "input_text" || type === "output_text" || type === "text") {
    const text = typeof part.text === "string" ? part.text : "";
    return text ? { type, text } : dropProxyJsonValue;
  }
  return dropProxyJsonValue;
}

function sanitizePlaintextMessage(item) {
  if (!item || typeof item !== "object" || item.type !== "message") return dropProxyJsonValue;
  if (item.role !== "user" && item.role !== "assistant") return dropProxyJsonValue;

  if (Array.isArray(item.content)) {
    const content = [];
    for (const part of item.content) {
      const sanitized = sanitizePlaintextContentPart(part);
      if (sanitized !== dropProxyJsonValue) content.push(sanitized);
    }
    if (content.length === 0) return dropProxyJsonValue;
    return {
      type: "message",
      role: item.role,
      content
    };
  }

  if (typeof item.content === "string" && item.content.trim()) {
    return {
      type: "message",
      role: item.role,
      content: item.content
    };
  }

  return dropProxyJsonValue;
}

function sanitizeCompactPlaintextJson(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value, removed: false };

  let removed = false;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key !== "input" || !Array.isArray(child)) {
      const stripped = stripEncryptedContentFromJson(child);
      if (stripped.removed) removed = true;
      if (stripped.value !== dropProxyJsonValue) out[key] = stripped.value;
      continue;
    }

    const input = [];
    for (const item of child) {
      const sanitized = sanitizePlaintextMessage(item);
      if (sanitized === dropProxyJsonValue) {
        removed = true;
        continue;
      }
      input.push(sanitized);
      if (sanitized !== item) removed = true;
    }
    out.input = input;
  }

  return { value: out, removed };
}

function stripEncryptedContentFromJson(value, options = {}) {
  if (options.plaintextOnlyCompact) {
    return sanitizeCompactPlaintextJson(value);
  }

  if (Array.isArray(value)) {
    let removed = false;
    const items = [];
    for (const item of value) {
      const next = stripEncryptedContentFromJson(item, options);
      if (next.removed) removed = true;
      if (next.value === dropProxyJsonValue) {
        removed = true;
        continue;
      }
      items.push(next.value);
    }
    return { value: items, removed };
  }

  if (!value || typeof value !== "object") {
    return { value, removed: false };
  }

  if (value.type === "reasoning") {
    return { value: dropProxyJsonValue, removed: true };
  }

  let removed = false;
  let removedOwnEncryptedContent = false;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (isEncryptedContentKey(key)) {
      removed = true;
      removedOwnEncryptedContent = true;
      continue;
    }
    const next = stripEncryptedContentFromJson(child, options);
    if (next.removed) removed = true;
    if (next.value !== dropProxyJsonValue) out[key] = next.value;
  }

  if (removedOwnEncryptedContent && shouldDropAfterEncryptedContentRemoval(out)) {
    return { value: dropProxyJsonValue, removed: true };
  }

  return { value: out, removed };
}

function proxyRequestContentEncodings(headers) {
  const raw = headers?.["content-encoding"] ?? headers?.["Content-Encoding"];
  if (!raw) return [];
  const joined = Array.isArray(raw) ? raw.join(",") : String(raw);
  return joined
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item && item !== "identity");
}

export function decodeProxyJsonBody(body, headers, { alreadyDecoded = false } = {}) {
  if (alreadyDecoded) return { body, decoded: false, decodeFailed: false };
  const encodings = proxyRequestContentEncodings(headers);
  if (encodings.length === 0) return { body, decoded: false, decodeFailed: false };
  if (encodings.length !== 1) return { body, decoded: false, decodeFailed: true };

  try {
    const encoding = encodings[0];
    if (encoding === "gzip" || encoding === "x-gzip") {
      return { body: zlib.gunzipSync(body), decoded: true, decodeFailed: false };
    }
    if (encoding === "deflate") {
      return { body: zlib.inflateSync(body), decoded: true, decodeFailed: false };
    }
    if (encoding === "br") {
      return { body: zlib.brotliDecompressSync(body), decoded: true, decodeFailed: false };
    }
  } catch {
    return { body, decoded: false, decodeFailed: true };
  }

  return { body, decoded: false, decodeFailed: true };
}

export function rewriteProviderProxyRequestBody(target, body, headers = {}, options = {}) {
  if (!body || !Buffer.isBuffer(body) || body.length === 0) {
    return {
      body,
      rewritten: false,
      decoded: false,
      decodeFailed: false,
      originalModel: null,
      remoteCompactionV2: false
    };
  }

  const decoded = decodeProxyJsonBody(body, headers, options);
  let parsed = null;
  try {
    parsed = JSON.parse(decoded.body.toString("utf8"));
  } catch {
    return {
      body,
      rewritten: false,
      decoded: decoded.decoded,
      decodeFailed: decoded.decodeFailed,
      originalModel: null,
      remoteCompactionV2: false
    };
  }

  const originalModel = typeof parsed?.model === "string" ? parsed.model : null;
  const remoteCompactionV2 = isCodexRemoteCompactionV2Request(target, parsed, headers);

  let rewritten = false;
  if (expandRemoteCompactionV2Summaries(parsed)) {
    rewritten = true;
  }
  if (isCompactProxyTarget(target) && parsed && parsed.client_metadata !== undefined) {
    delete parsed.client_metadata;
    rewritten = true;
  }

  const resolvedModel = resolvedClaudeGatewayModelId(parsed?.model);
  if (resolvedModel && parsed.model !== resolvedModel) {
    parsed.model = resolvedModel;
    rewritten = true;
  }

  const mappedModel = remappedProxyRequestModel(parsed?.model, target, {
    compact: isCompactProxyTarget(target)
  });
  if (mappedModel && parsed.model !== mappedModel) {
    parsed.model = mappedModel;
    rewritten = true;
  }

  if (Array.isArray(parsed?.tools)) {
    for (const tool of parsed.tools) {
      if (tool && tool.model === "gpt-image-2-codex") {
        tool.model = "gpt-image-2";
        rewritten = true;
      }
    }
  }

  if (!rewritten) {
    return {
      body: decoded.decoded ? decoded.body : body,
      rewritten: false,
      decoded: decoded.decoded,
      decodeFailed: decoded.decodeFailed,
      originalModel,
      remoteCompactionV2
    };
  }

  return {
    body: Buffer.from(JSON.stringify(parsed), "utf8"),
    rewritten: true,
    decoded: true,
    decodeFailed: decoded.decodeFailed,
    originalModel,
    remoteCompactionV2
  };
}

export function stripEncryptedContentFromProxyBody(body, headers = {}, options = {}) {
  if (!body || !Buffer.isBuffer(body) || body.length === 0) return { body, removed: false };
  const decoded = decodeProxyJsonBody(body, headers, options);
  let parsed = null;
  try {
    parsed = JSON.parse(decoded.body.toString("utf8"));
  } catch {
    return { body, removed: false, decoded: decoded.decoded, decodeFailed: decoded.decodeFailed };
  }
  const stripped = stripEncryptedContentFromJson(parsed, options);
  if (!stripped.removed || stripped.value === dropProxyJsonValue) {
    return {
      body: decoded.decoded ? decoded.body : body,
      removed: false,
      decoded: decoded.decoded,
      decodeFailed: decoded.decodeFailed
    };
  }
  return {
    body: Buffer.from(JSON.stringify(stripped.value)),
    removed: true,
    decoded: decoded.decoded,
    decodeFailed: decoded.decodeFailed
  };
}

export function ensureEncryptedContent(val) {
  if (Array.isArray(val)) {
    for (const item of val) {
      ensureEncryptedContent(item);
    }
    return;
  }
  if (!val || typeof val !== "object") {
    return;
  }
  const type = typeof val.type === "string" ? val.type : "";
  const needsEncryptedContent = type === "response.compaction" || type === "message" || type === "reasoning";
  if (needsEncryptedContent) {
    if (val.encrypted_content === undefined && val.encryptedContent === undefined) {
      val.encrypted_content = "";
    }
  }
  for (const child of Object.values(val)) {
    ensureEncryptedContent(child);
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

export function createSseResponseTransformStream(target, isEventStream, diagnostics = null) {
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

export function isCompactProxyTarget(target) {
  try {
    return new URL(target.url).pathname.endsWith("/responses/compact");
  } catch {
    return false;
  }
}

// Claude Code sends /compact as a plain POST /v1/messages request whose only
// user message asks the model to summarize the conversation. There is no
// dedicated endpoint, so detection has to be content-based.
const claudeCompactionPromptMarkers = [
  "detailed summary of the conversation",
  "summary of the conversation so far",
  "summarize the conversation so far",
  "summarize this conversation",
  "compact this conversation",
  "conversation so far, paying special attention"
];

function claudeCompactionMarkerInText(text) {
  const lower = String(text || "").toLowerCase();
  return claudeCompactionPromptMarkers.some((marker) => lower.includes(marker));
}

function claudeCompactionMarkerInContent(content) {
  if (typeof content === "string") return claudeCompactionMarkerInText(content);
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (typeof part === "string") return claudeCompactionMarkerInText(part);
    if (!part || typeof part !== "object") return false;
    if (part.type !== undefined && part.type !== "text" && part.type !== "input_text") return false;
    return claudeCompactionMarkerInText(part.text ?? part.content);
  });
}

export function isClaudeCompactionPayload(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  if (messages.length === 0) return false;
  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role !== "user") return false;
  return claudeCompactionMarkerInContent(lastMessage.content);
}

export function isClaudeMessagesCompactionTarget(target, parsed) {
  if (!isClaudeCompactionPayload(parsed)) return false;
  try {
    return new URL(target?.url || "").pathname.replace(/\/$/, "").endsWith("/v1/messages");
  } catch {
    return false;
  }
}

export function repairProviderProxyBodyPlaintext(target, body, headers = {}, options = {}) {
  if (!target.repairInvalidEncryptedContent || !isCompactProxyTarget(target)) {
    return { body, repaired: false };
  }
  const stripped = stripEncryptedContentFromProxyBody(body, headers, {
    ...options,
    plaintextOnlyCompact: true
  });
  return {
    body: stripped.body,
    repaired: stripped.removed,
    decoded: stripped.decoded === true,
    decodeFailed: stripped.decodeFailed === true
  };
}

function textFromCompletionContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("");
}

function summaryFromChatCompletionJson(value) {
  if (!value || typeof value !== "object") return "";
  if (typeof value.output_text === "string") return value.output_text;

  const firstChoice = Array.isArray(value.choices) ? value.choices[0] : null;
  const choiceText = textFromCompletionContent(firstChoice?.message?.content)
    || textFromCompletionContent(firstChoice?.delta?.content)
    || (typeof firstChoice?.text === "string" ? firstChoice.text : "");
  if (choiceText) return choiceText;

  if (Array.isArray(value.output)) {
    return value.output
      .map((item) => textFromCompletionContent(item?.content))
      .filter(Boolean)
      .join("");
  }

  return "";
}

function summaryFromChatCompletionSse(text) {
  let summary = "";
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data: ")) continue;
    const jsonText = trimmed.slice(6).trim();
    if (!jsonText || jsonText === "[DONE]") continue;
    try {
      summary += summaryFromChatCompletionJson(JSON.parse(jsonText));
    } catch {
      // Ignore malformed SSE data lines.
    }
  }
  return summary;
}

async function readChatCompletionSummary(response) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const text = await response.text();
  if (contentType.includes("event-stream")) {
    return summaryFromChatCompletionSse(text);
  }
  try {
    return summaryFromChatCompletionJson(JSON.parse(text));
  } catch {
    return summaryFromChatCompletionSse(text);
  }
}

function compactTextContent(text, role = "assistant") {
  return [
    {
      type: role === "user" ? "input_text" : "output_text",
      text
    }
  ];
}

function compactTextMessage(text) {
  return {
    type: "message",
    role: "assistant",
    content: compactTextContent(text, "assistant"),
    encrypted_content: ""
  };
}

function normalizeCompactionContentPart(part, role = "assistant") {
  const defaultType = role === "user" ? "input_text" : "output_text";
  if (typeof part === "string") {
    return { type: defaultType, text: part };
  }
  if (!part || typeof part !== "object") return part;
  const text = typeof part.text === "string"
    ? part.text
    : typeof part.content === "string"
      ? part.content
      : null;
  const type = typeof part.type === "string" ? part.type : "";
  if (type === "text") {
    return text == null ? { ...part, type: defaultType } : { type: defaultType, text };
  }
  if (role !== "user" && type === "input_text" && text != null) {
    return { type: "output_text", text };
  }
  if (role === "user" && type === "output_text" && text != null) {
    return { type: "input_text", text };
  }
  if (!type && text != null) {
    return { type: defaultType, text };
  }
  return part;
}

// Codex's remote compaction v2 parser accepts EXACTLY ONE compaction output
// item. Providers sometimes return extras (reasoning items, empty phantom
// messages) alongside the summary — e.g. VSLLM's compact endpoint returning
// [reasoning, message], which Codex rejects with "expected exactly one
// compaction output item, got 0 from 2". Pick the single best message item
// (the last one carrying non-empty text) and drop everything else.
function compactionMessageText(item) {
  if (!item || typeof item !== "object" || item.type !== "message") return "";
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return "";
  return item.content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      return typeof part.text === "string"
        ? part.text
        : typeof part.content === "string"
          ? part.content
          : "";
    })
    .join("");
}

function selectSingleCompactionOutputItem(items) {
  if (!Array.isArray(items)) return items;
  const messages = items.filter((item) => item && typeof item === "object" && item.type === "message");
  const withText = messages.filter((item) => compactionMessageText(item).trim().length > 0);
  const chosen = withText.length > 0
    ? withText[withText.length - 1]
    : messages.length > 0
      ? messages[messages.length - 1]
      : null;
  if (!chosen) return items.filter((item) => item && typeof item === "object");
  return [chosen];
}

function normalizeCompactionMessageContent(item) {
  if (!item || typeof item !== "object" || item.type !== "message") return;
  const role = typeof item.role === "string" ? item.role : "assistant";
  if (typeof item.content === "string") {
    item.content = compactTextContent(item.content, role);
    return;
  }
  if (Array.isArray(item.content)) {
    item.content = item.content.map((part) => normalizeCompactionContentPart(part, role));
  }
}

export function normalizeCompactionResponse(value) {
  if (!value || typeof value !== "object") return;
  if (value.type !== "response.compaction" && value.object !== "response.compaction") return;
  if (value.type !== "response.compaction") {
    value.type = "response.compaction";
  }
  if (value.messages && !value.output) {
    value.output = value.messages;
  }
  if (value.output && !value.messages) {
    value.messages = value.output;
  }
  const sourceItems = Array.isArray(value.output)
    ? value.output
    : Array.isArray(value.messages)
      ? value.messages
      : null;
  if (sourceItems) {
    // The legacy /responses/compact response carries one condensed message;
    // collapse provider-added reasoning and empty message items around it.
    const single = selectSingleCompactionOutputItem(sourceItems);
    value.output = single;
    value.messages = single;
  }
  for (const items of [value.messages, value.output]) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      normalizeCompactionMessageContent(item);
    }
  }
}

function compactionCompletionsUrl(target) {
  return compactionShapeUrl(target, "chat_completions");
}

// Derive the per-shape URL on the same upstream for a compact fallback call.
// VSLLM exposes the same model on every wire shape, so we just rewrite the
// path. Antigravity uses Google's Gemini :generateContent envelope and is
// keyed off the original model id from the request.
export function compactionShapeUrl(target, shape, modelId) {
  try {
    const url = new URL(target.url);
    let pathname = url.pathname;
    if (shape === "chat_completions") {
      pathname = pathname
        .replace(/\/responses\/compact\/?$/, "/chat/completions")
        .replace(/\/responses\/?$/, "/chat/completions")
        .replace(/\/v1\/messages\/?$/, "/chat/completions")
        .replace(/\/v1beta\/models\/[^:]+\:generateContent\/?$/, "/chat/completions")
        .replace(/\/v1beta\/models\/[^:]+\:streamGenerateContent\/?$/, "/chat/completions");
    } else if (shape === "messages") {
      pathname = pathname
        .replace(/\/responses\/compact\/?$/, "/messages")
        .replace(/\/responses\/?$/, "/messages")
        .replace(/\/chat\/completions\/?$/, "/messages")
        .replace(/\/v1beta\/models\/[^:]+\:generateContent\/?$/, "/messages")
        .replace(/\/v1beta\/models\/[^:]+\:streamGenerateContent\/?$/, "/messages");
    } else if (shape === "antigravity") {
      const model = modelId || extractModelFromCompactUrl(url.pathname);
      pathname = model
        ? `/v1beta/models/${encodeURIComponent(model)}:generateContent`
        : pathname
          .replace(/\/chat\/completions\/?$/, "/v1beta/models/__unknown__:generateContent")
          .replace(/\/v1\/messages\/?$/, "/v1beta/models/__unknown__:generateContent")
          .replace(/\/responses(?:\/compact)?\/?$/, "/v1beta/models/__unknown__:generateContent");
    } else {
      return null;
    }
    if (pathname === url.pathname) return null;
    url.pathname = pathname;
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

function extractModelFromCompactUrl(pathname) {
  const m = String(pathname || "").match(/\/v1beta\/models\/([^/:]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function extractModelFromRequest(parsed) {
  return typeof parsed?.model === "string" && parsed.model.trim() ? parsed.model.trim() : null;
}

// Remote compaction v2 is streamed through /responses. Codex accepts exactly
// one output item with type "compaction" and then a response.completed event.
// The encrypted-content field is opaque to Codex; locally-generated summaries
// are tagged so the proxy can expand them into provider-readable context on a
// later request.
export function remoteCompactionV2Response(summaryText) {
  const responseId = `resp_compact_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const compactionItem = {
    type: "compaction",
    encrypted_content: encodeRemoteCompactionV2Summary(summaryText)
  };
  const events = [
    {
      type: "response.output_item.done",
      output_index: 0,
      item: compactionItem
    },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [compactionItem]
      }
    }
  ];
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: new Headers({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache"
    })
  });
}

// Claude Code compaction: the full transcript plus the summarization
// request arrive as one (large) user message. Forward it verbatim — do NOT
// truncate — so the upstream model summarizes the complete conversation.
function claudeCompactionTranscriptText(parsed) {
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const lastMessage = messages[messages.length - 1];
  const text = typeof lastMessage?.content === "string"
    ? lastMessage.content
    : (Array.isArray(lastMessage?.content) ? lastMessage.content : [])
      .filter((part) => part && typeof part === "object" && (part.type === "text" || part.type === "input_text" || part.type === undefined))
      .map((part) => String(part.text ?? part.content ?? ""))
      .join("\n");
  return text.trim() ? text : null;
}

// Build a flat text transcript from a Codex /v1/responses/compact payload so
// any wire shape can summarize it with a one-shot prompt. Items that are
// purely metadata (compaction_trigger, reasoning) are dropped; messages,
// compaction summaries (this proxy's own encrypted_content tag), function
// calls, and function outputs are preserved verbatim.
function extractCompactConversationText(parsed) {
  const inputItems = Array.isArray(parsed?.input) ? parsed.input : [];
  let text = "";
  for (const item of inputItems) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "message") {
      const role = item.role || "unknown";
      const parts = [];
      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part && typeof part.text === "string") {
            parts.push(part.text);
          } else if (part && typeof part === "object" && typeof part.content === "string") {
            parts.push(part.content);
          } else if (typeof part === "string") {
            parts.push(part);
          }
        }
      } else if (typeof item.content === "string") {
        parts.push(item.content);
      }
      if (parts.length > 0) text += `[${role}]: ${parts.join("\n")}\n\n`;
    } else if (item.type === "compaction") {
      const summary = decodeRemoteCompactionV2Summary(item.encrypted_content);
      if (summary) text += `[earlier compacted context]: ${summary}\n\n`;
    } else if (item.type === "function_call") {
      text += `[assistant called function]: ${item.name || ""} with arguments ${item.arguments || ""}\n\n`;
    } else if (item.type === "function_call_output") {
      text += `[function output]: ${item.output ?? ""}\n\n`;
    }
  }
  return text.trim();
}

const summarizeSystemPrompt = `You are a helper that compacts and summarizes conversational context for an AI agent.
Analyze the following conversation history and produce a concise, highly detailed summary of what has been discussed and accomplished so far.
Focus on:
1. The user's goal and requirements.
2. The key technical details, decisions, and instructions established.
3. Code blocks, modifications, or implementations that were written or modified.
4. Current outstanding tasks or next steps.

Produce a clear, structured summary in Markdown format. Keep the summary under 800 words.`;

// Build the per-shape summarization body for compact fallback.
function buildCompactSummarizeBody({ shape, model, conversationText, reasoningEffort, target }) {
  const reasoning = isVsllmApiAccount(target?.account, target?.upstreamBaseUrl || target?.url || "")
    && typeof reasoningEffort === "string" && reasoningEffort.trim()
    ? reasoningEffort.trim()
    : null;
  const userPrompt = `Here is the conversation history to summarize:\n\n${conversationText}`;
  if (shape === "chat_completions") {
    const body = {
      model,
      messages: [
        { role: "system", content: summarizeSystemPrompt },
        { role: "user", content: userPrompt }
      ]
    };
    if (reasoning) body.reasoning_effort = reasoning;
    return body;
  }
  if (shape === "messages") {
    const body = {
      model,
      max_tokens: 4096,
      system: summarizeSystemPrompt,
      messages: [{ role: "user", content: userPrompt }]
    };
    if (reasoning) body.thinking = { type: "enabled", budget_tokens: 2048 };
    return body;
  }
  if (shape === "antigravity") {
    const body = {
      contents: [
        { role: "user", parts: [{ text: `${summarizeSystemPrompt}\n\n${userPrompt}` }] }
      ]
    };
    return body;
  }
  return null;
}

async function readShapeSummarizeResponse({ shape, res }) {
  if (res.status !== 200) return null;
  const text = await res.text();
  if (!text) return null;
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (shape === "chat_completions") {
    const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null;
    const content = choice?.message?.content;
    return typeof content === "string" ? content.trim() : null;
  }
  if (shape === "messages") {
    if (Array.isArray(parsed?.content)) {
      const textPart = parsed.content.find((p) => p && p.type === "text");
      if (textPart && typeof textPart.text === "string") return textPart.text.trim();
    }
    return null;
  }
  if (shape === "antigravity") {
    const candidate = Array.isArray(parsed?.candidates) ? parsed.candidates[0] : null;
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    const textPart = parts.find((p) => p && typeof p.text === "string");
    return textPart ? String(textPart.text).trim() : null;
  }
  return null;
}

// Wrap a compact summary into the Codex /v1/responses/compact response envelope.
function codexCompactResponse(summaryText, parsed) {
  const compactedMessage = compactTextMessage(summaryText);
  return {
    type: "response.compaction",
    encrypted_content: "",
    messages: [compactedMessage],
    output: [compactedMessage]
  };
}

// Try one shape's endpoint on the same upstream as a real summarization call
// for compact. Returns a Codex-compact-formatted Response on success or null
// on any failure. The summarization request is a fresh one-shot prompt and
// does NOT forward the original compact payload (which is unreadable by the
// non-Responses shape). The summary text is wrapped in Codex-compact format.
export async function summarizeViaShape({ shape, target, body, headers, alreadyDecoded, sanitizeRequestHeaders, options = {} }) {
  if (!shape || shape === "responses") return null;
  const startTime = Date.now();
  const decoded = decodeProxyJsonBody(body, headers, { alreadyDecoded });
  let parsed = null;
  try { parsed = JSON.parse(decoded.body.toString("utf8")); } catch { return null; }
  const fallbackModel = typeof options.originalModel === "string" && options.originalModel.trim()
    ? options.originalModel.trim()
    : extractModelFromRequest(parsed) || "gpt-5.6-sol";
  const conversationText = extractCompactConversationText(parsed);
  if (!conversationText) {
    console.error(`[Proxy Compact Shape] No conversation text found for shape ${shape} on ${target?.url}.`);
    return null;
  }
  const shapeUrl = compactionShapeUrl(target, shape, fallbackModel);
  if (!shapeUrl) {
    console.error(`[Proxy Compact Shape] Cannot derive ${shape} URL from ${target?.url}.`);
    return null;
  }
  const summarizeBody = buildCompactSummarizeBody({
    shape,
    model: fallbackModel,
    conversationText,
    reasoningEffort: parsed?.reasoning?.effort ?? parsed?.reasoning_effort,
    target
  });
  if (!summarizeBody) return null;
  const authHeaders = sanitizeRequestHeaders(headers, target, { omitContentEncoding: true });
  try {
    const res = await fetch(shapeUrl, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(summarizeBody),
      signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(60000) : undefined
    });
    const summaryText = await readShapeSummarizeResponse({ shape, res });
    if (!summaryText) {
      console.error(`[Proxy Compact Shape] ${shape} endpoint returned status ${res.status} or empty summary.`);
      return null;
    }
    console.log(`[Proxy Compact Shape] ${shape} summary generated in ${((Date.now() - startTime) / 1000).toFixed(2)}s. Size: ${summaryText.length} chars.`);
    const compactJson = codexCompactResponse(summaryText, parsed);
    const responseBody = Buffer.from(JSON.stringify(compactJson), "utf8");
    return new Response(responseBody, {
      status: 200,
      headers: new Headers({
        "content-type": "application/json; charset=utf-8",
        "content-length": String(responseBody.length)
      })
    });
  } catch (err) {
    console.error(`[Proxy Compact Shape] ${shape} fallback failed:`, err?.message || err);
    return null;
  }
}

export async function runLocalCompactionFallback(target, body, headers, alreadyDecoded, sanitizeRequestHeaders, options = {}) {
  const startTime = Date.now();
  const completionsUrl = compactionCompletionsUrl(target);
  if (!completionsUrl) {
    console.error(`[Proxy Local Compaction] Cannot derive a chat completions endpoint from ${target?.url}`);
    return null;
  }
  console.log(`[Proxy Local Compaction] Starting local compaction fallback using completions on ${completionsUrl}...`);

  const decoded = decodeProxyJsonBody(body, headers, { alreadyDecoded });
  let parsed = null;
  try {
    parsed = JSON.parse(decoded.body.toString("utf8"));
  } catch (err) {
    console.error(`[Proxy Local Compaction] Failed to parse request body as JSON:`, err);
    return null;
  }

  const claudeFormat = isClaudeMessagesCompactionTarget(target, parsed);
  const remoteCompactionV2 = options.remoteCompactionV2 === true;
  const authHeaders = sanitizeRequestHeaders(headers, target, {
    omitContentEncoding: true
  });
  const reasoningEffort = parsed?.reasoning?.effort ?? parsed?.reasoning_effort;
  const applyReasoningEffort = (completionBody) => {
    if (isVsllmApiAccount(target?.account, target?.upstreamBaseUrl || target?.url || "") && typeof reasoningEffort === "string" && reasoningEffort.trim()) {
      completionBody.reasoning_effort = reasoningEffort.trim();
    }
    return completionBody;
  };

  // Codex /responses/compact path: the native compact endpoint failed, so we
  // re-summarize via chat completions. A dedicated compact model id is the
  // wrong choice here — it was sized for the small condensed payload, not the
  // full conversation — so reuse the request's own model. Prefer the
  // pre-rewrite original model (the proxy body may already have been remapped
  // to the compact-specific id), falling back to the non-compact remap only
  // when the request omitted a model.
  const fallbackModel = typeof options.originalModel === "string" && options.originalModel.trim()
    ? options.originalModel.trim()
    : typeof parsed?.model === "string" && parsed.model.trim()
      ? parsed.model.trim()
      : remappedProxyRequestModel(parsed?.model || "gpt-5.5", target, { compact: false }) || "gpt-5.5";

  // Claude path: send the complete, untruncated transcript for summarization.
  if (claudeFormat) {
    const transcript = claudeCompactionTranscriptText(parsed);
    if (!transcript) {
      console.error(`[Proxy Local Compaction] Claude compaction request had no transcript text.`);
      return null;
    }
    const completionBody = applyReasoningEffort({
      model: fallbackModel,
      stream: false,
      messages: [{ role: "user", content: transcript }]
    });
    try {
      const res = await fetch(completionsUrl, {
        method: "POST",
        headers: {
          ...authHeaders,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(completionBody),
        signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(90000) : undefined
      });
      if (res.status !== 200) {
        console.error(`[Proxy Local Compaction] completions endpoint failed with status: ${res.status}`);
        return null;
      }
      const summaryText = await readChatCompletionSummary(res);
      if (!summaryText.trim()) {
        console.error(`[Proxy Local Compaction] completions endpoint returned an empty summary.`);
        return null;
      }
      console.log(`[Proxy Local Compaction] Summary successfully generated in ${((Date.now() - startTime) / 1000).toFixed(2)}s. Summary size: ${summaryText.length} chars.`);
      return claudeMessagesCompactionResponse(summaryText, parsed?.model);
    } catch (err) {
      console.error(`[Proxy Local Compaction] Fallback failed with error:`, err);
      return null;
    }
  }

  // Codex /responses/compact path: the native compact endpoint failed, so we
  // re-summarize via chat completions. Send the FULL conversation — no item
  // dropping, no per-item truncation — so the summary reflects everything.
  const conversationText = extractCompactConversationText(parsed);
  if (!conversationText) {
    console.error(`[Proxy Local Compaction] No conversation text found in compact payload.`);
    return null;
  }
  const userPrompt = `Here is the conversation history to summarize:\n\n${conversationText}`;

  const completionBody = applyReasoningEffort({
    model: fallbackModel,
    messages: [
      { role: "system", content: summarizeSystemPrompt },
      { role: "user", content: userPrompt }
    ]
  });

  try {
    const res = await fetch(completionsUrl, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(completionBody),
      signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(90000) : undefined
    });

    if (res.status !== 200) {
      console.error(`[Proxy Local Compaction] completions endpoint failed with status: ${res.status}`);
      return null;
    }

    const summaryText = await readChatCompletionSummary(res);
    if (!summaryText.trim()) {
      console.error(`[Proxy Local Compaction] completions endpoint returned an empty summary.`);
      return null;
    }

    console.log(`[Proxy Local Compaction] Summary successfully generated in ${((Date.now() - startTime) / 1000).toFixed(2)}s. Summary size: ${summaryText.length} chars.`);

    if (claudeFormat) {
      return claudeMessagesCompactionResponse(summaryText, parsed?.model);
    }

    if (remoteCompactionV2) {
      return remoteCompactionV2Response(summaryText);
    }

    const compactedMessage = compactTextMessage(summaryText);
    const compactionResponse = {
      type: "response.compaction",
      encrypted_content: "",
      messages: [compactedMessage],
      output: [compactedMessage]
    };

    return new Response(JSON.stringify(compactionResponse), {
      status: 200,
      headers: new Headers({
        "content-type": "application/json; charset=utf-8"
      })
    });
  } catch (err) {
    console.error(`[Proxy Local Compaction] Fallback failed with error:`, err);
    return null;
  }
}

function claudeMessagesJsonResponse(body, extraHeaders = {}) {
  const responseBody = Buffer.from(JSON.stringify(body), "utf8");
  return new Response(responseBody, {
    status: 200,
    headers: new Headers({
      "content-type": "application/json; charset=utf-8",
      "content-length": String(responseBody.length),
      ...extraHeaders
    })
  });
}

// Claude Code's streaming HTTP client must see SSE framing (event:/data:
// pairs terminated by [DONE]) or it keeps waiting on the stream, so the
// summary is emitted as a complete Anthropic Messages SSE sequence.
export function claudeMessagesCompactionResponse(summaryText, model) {
  const messageId = `msg_compact_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const resolvedModel = typeof model === "string" && model.trim() ? model.trim() : "unknown";
  const messageStart = {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: resolvedModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  };
  const textDelta = {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: String(summaryText || "") }
  };
  const messageDelta = {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 0 }
  };
  const events = [
    ["message_start", messageStart],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", textDelta],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", messageDelta],
    ["message_stop", { type: "message_stop" }]
  ];
  let sse = "";
  for (const [event, payload] of events) {
    sse += `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  }
  sse += "data: [DONE]\n\n";
  return new Response(sse, {
    status: 200,
    headers: new Headers({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache"
    })
  });
}
