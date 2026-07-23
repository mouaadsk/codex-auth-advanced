import { Transform } from "node:stream";
import zlib from "node:zlib";
import {
  isVsllmApiAccount,
  remappedProxyRequestModel,
  resolvedClaudeGatewayModelId
} from "./provider-policy.mjs";

const dropProxyJsonValue = Symbol("dropProxyJsonValue");

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
    return { body, rewritten: false, decoded: false, decodeFailed: false, originalModel: null };
  }

  const decoded = decodeProxyJsonBody(body, headers, options);
  let parsed = null;
  try {
    parsed = JSON.parse(decoded.body.toString("utf8"));
  } catch {
    return { body, rewritten: false, decoded: decoded.decoded, decodeFailed: decoded.decodeFailed, originalModel: null };
  }

  const originalModel = typeof parsed?.model === "string" ? parsed.model : null;

  let rewritten = false;
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

  if (!rewritten) {
    return {
      body: decoded.decoded ? decoded.body : body,
      rewritten: false,
      decoded: decoded.decoded,
      decodeFailed: decoded.decodeFailed,
      originalModel
    };
  }

  return {
    body: Buffer.from(JSON.stringify(parsed), "utf8"),
    rewritten: true,
    decoded: true,
    decodeFailed: decoded.decodeFailed,
    originalModel
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
  for (const items of [value.messages, value.output]) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      normalizeCompactionMessageContent(item);
    }
  }
}

export async function runLocalCompactionFallback(target, body, headers, alreadyDecoded, sanitizeRequestHeaders) {
  const startTime = Date.now();
  const completionsUrl = target.url.replace(/\/responses\/compact\/?$/, "/chat/completions");
  console.log(`[Proxy Local Compaction] Starting local compaction fallback using completions on ${completionsUrl}...`);

  const decoded = decodeProxyJsonBody(body, headers, { alreadyDecoded });
  let parsed = null;
  try {
    parsed = JSON.parse(decoded.body.toString("utf8"));
  } catch (err) {
    console.error(`[Proxy Local Compaction] Failed to parse request body as JSON:`, err);
    return null;
  }

  const inputItems = parsed.input || [];
  const processedItems = [];
  if (inputItems.length <= 25) {
    processedItems.push(...inputItems);
  } else {
    processedItems.push(...inputItems.slice(0, 5));
    processedItems.push(...inputItems.slice(-15));
  }

  let conversationText = "";
  for (const item of processedItems) {
    if (item.type === "message") {
      const role = item.role || "unknown";
      const parts = [];
      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part && typeof part.text === "string") {
            let text = part.text;
            if (text.length > 3000) {
              text = text.slice(0, 3000) + "\n\n... [TRUNCATED] ...";
            }
            parts.push(text);
          }
        }
      } else if (typeof item.content === "string") {
        let text = item.content;
        if (text.length > 3000) {
          text = text.slice(0, 3000) + "\n\n... [TRUNCATED] ...";
        }
        parts.push(text);
      }
      conversationText += `[${role}]: ${parts.join("\n")}\n\n`;
    } else if (item.type === "function_call") {
      conversationText += `[assistant called function]: ${item.name} with arguments ${item.arguments}\n\n`;
    } else if (item.type === "function_call_output") {
      let outStr = item.output || "";
      if (outStr.length > 2000) {
        outStr = outStr.slice(0, 2000) + "\n\n... [TRUNCATED] ...";
      }
      conversationText += `[function output]: ${outStr}\n\n`;
    }
  }

  const systemPrompt = `You are a helper that compacts and summarizes conversational context for an AI agent.
Analyze the following conversation history and produce a concise, highly detailed summary of what has been discussed and accomplished so far.
Focus on:
1. The user's goal and requirements.
2. The key technical details, decisions, and instructions established.
3. Code blocks, modifications, or implementations that were written or modified.
4. Current outstanding tasks or next steps.

Produce a clear, structured summary in Markdown format. Keep the summary under 800 words.`;

  const userPrompt = `Here is the conversation history to summarize:\n\n${conversationText}`;

  const authHeaders = sanitizeRequestHeaders(headers, target, {
    omitContentEncoding: true
  });
  const fallbackModel = remappedProxyRequestModel(parsed.model || "gpt-5.5", target, {
    compact: true
  }) || parsed.model || "gpt-5.5";

  const completionBody = {
    model: fallbackModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  };
  const reasoningEffort = parsed?.reasoning?.effort ?? parsed?.reasoning_effort;
  if (isVsllmApiAccount(target?.account, target?.upstreamBaseUrl || target?.url || "") && typeof reasoningEffort === "string" && reasoningEffort.trim()) {
    completionBody.reasoning_effort = reasoningEffort.trim();
  }

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

export function dummyCompactionResponse(errorMsg) {
  const summaryText = `[COMPACTION FALLBACK WARNING]\nLocal compaction failed due to: ${errorMsg || "Timeout or API error"}.\nTo prevent session crash, a dummy placeholder compaction response was returned. The conversation history has been truncated, but outstanding tasks and core instructions might need to be re-referenced if missing.`;
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
}
