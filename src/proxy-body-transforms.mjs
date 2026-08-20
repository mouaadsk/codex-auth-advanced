import zlib from "node:zlib";
import {
  isVsllmApiAccount,
  remappedProxyRequestModel,
  resolvedClaudeGatewayModelId
} from "./provider-policy.mjs";
import { isResponsesProxyTarget } from "./proxy-sse-transforms.mjs";
import { isCompactProxyTarget } from "./proxy-compaction.mjs";

const dropProxyJsonValue = Symbol("dropProxyJsonValue");
const remoteCompactionV2SummaryPrefix = "codex-auth-advanced:remote-compaction-v2:";

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function decodeRemoteCompactionV2Summary(value) {
  if (typeof value !== "string" || !value.startsWith(remoteCompactionV2SummaryPrefix)) return null;
  try {
    const summary = Buffer.from(value.slice(remoteCompactionV2SummaryPrefix.length), "base64url").toString("utf8");
    return summary.trim() ? summary : null;
  } catch {
    return null;
  }
}

export function encodeRemoteCompactionV2Summary(summary) {
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

