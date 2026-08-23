import { randomUUID } from "node:crypto";
import {
  isVsllmApiAccount,
  providerSlugForTarget,
  remappedProxyRequestModel,
  resolvedClaudeGatewayModelId
} from "./provider-policy.mjs";
import {
  decodeProxyJsonBody,
  decodeRemoteCompactionV2Summary,
  encodeRemoteCompactionV2Summary,
  rewriteProviderProxyRequestBody,
  stripEncryptedContentFromProxyBody
} from "./proxy-body-transforms.mjs";

const compactionFailures = new WeakMap();
const compactionFailurePriorities = {
  invalid_request: 120,
  missing_conversation: 120,
  configuration: 115,
  access: 100,
  quota: 100,
  timeout: 90,
  network: 85,
  upstream_unavailable: 80,
  unsupported_endpoint: 75,
  upstream_rejected: 70,
  invalid_response: 50
};

// New API can route two requests for the same public model to different
// upstream channels. Some channels validate reasoning_effort against a
// narrower capability list and return HTTP 400 for a high-end level such as
// `max`, `xhigh`, or `ultra`, while another channel behind the same VSLLM
// account accepts it. The request is a local, non-streaming summarization
// call, so a small bounded retry is safe and does not change the requested
// effort or silently downgrade quality.
const vsllmReasoningLevelMaxRetries = 2;
const vsllmReasoningLevelRetryDelayMs = 150;
const vsllmReasoningRetryEfforts = new Set(["max", "xhigh", "ultra"]);

function reasoningEffortFromRequestBody(body) {
  if (!body || typeof body !== "object") return "";
  const effort = body.reasoning_effort ?? body.reasoning?.effort;
  return typeof effort === "string" ? effort.trim().toLowerCase() : "";
}

function isVsllmReasoningRetryTarget(target) {
  return providerSlugForTarget(target, target?.account) === "vsllm";
}

export function isUnsupportedVsllmReasoningLevelResponse(text, requestedEffort = "max") {
  const expected = String(requestedEffort || "").trim().toLowerCase();
  if (!expected) return false;
  const raw = String(text || "");
  let source = raw;
  try {
    const parsed = JSON.parse(raw);
    source = String(parsed?.error?.message ?? parsed?.message ?? raw);
  } catch {
    // Some gateways prefix/suffix their JSON error. Match the raw body below.
  }
  const match = source.match(/level\s+["']([^"']+)["']\s+not\s+supported\b/i);
  if (!match || String(match[1] || "").trim().toLowerCase() !== expected) return false;
  return /valid\s+levels?\s*:/i.test(source);
}

export async function fetchCompactionWithVsllmReasoningRetry(url, init, {
  target,
  requestBody,
  timeoutMs,
  label = "summarization",
  // Tests can inject a fetcher and zero-delay sleeper. Production callers use
  // the global fetch and a short delay so New API can select another channel.
  fetchImpl = globalThis.fetch,
  delayMs = vsllmReasoningLevelRetryDelayMs,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  const requestedEffort = reasoningEffortFromRequestBody(requestBody);
  const eligible = isVsllmReasoningRetryTarget(target)
    && vsllmReasoningRetryEfforts.has(requestedEffort);
  const maxRetries = eligible ? vsllmReasoningLevelMaxRetries : 0;
  let response = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const attemptInit = { ...init };
    if (Number.isFinite(Number(timeoutMs))
      && Number(timeoutMs) > 0
      && typeof AbortSignal !== "undefined"
      && typeof AbortSignal.timeout === "function") {
      attemptInit.signal = AbortSignal.timeout(Number(timeoutMs));
    }
    response = await fetchImpl(url, attemptInit);
    if (!eligible || response.status !== 400 || attempt >= maxRetries) return response;

    const errorText = await response.clone().text().catch(() => "");
    if (!isUnsupportedVsllmReasoningLevelResponse(errorText, requestedEffort)) return response;

    console.warn(
      `[Proxy Local Compaction] VSLLM rejected reasoning level ${JSON.stringify(requestedEffort)} for ${label}; retrying through the provider channel selector (${attempt + 1}/${maxRetries}).`
    );
    await sleep(Math.max(0, Number(delayMs) || 0));
  }

  return response;
}

function resetCompactionFailure(target) {
  if (target && typeof target === "object") compactionFailures.delete(target);
}

function recordCompactionFailure(target, kind, status = null) {
  if (!target || typeof target !== "object") return;
  const numericStatus = status == null ? null : Number(status);
  const next = {
    kind,
    status: Number.isFinite(numericStatus) ? numericStatus : null
  };
  const current = compactionFailures.get(target);
  const currentPriority = compactionFailurePriorities[current?.kind] ?? 0;
  const nextPriority = compactionFailurePriorities[next.kind] ?? 0;
  if (!current || nextPriority > currentPriority) compactionFailures.set(target, next);
}

function compactionFailureKindForStatus(status) {
  if (status === 401 || status === 403) return "access";
  if (status === 402 || status === 429) return "quota";
  if (status === 408 || status === 504 || status === 524) return "timeout";
  if (status === 404 || status === 405) return "unsupported_endpoint";
  if (status >= 500) return "upstream_unavailable";
  return "upstream_rejected";
}

function recordCompactionHttpFailure(target, status) {
  recordCompactionFailure(target, compactionFailureKindForStatus(Number(status)), status);
}

function recordCompactionFailureIfUnset(target, kind, status = null) {
  if (!target || typeof target !== "object" || compactionFailures.has(target)) return;
  recordCompactionFailure(target, kind, status);
}

function recordCompactionFetchFailure(target, error) {
  const name = String(error?.name || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  recordCompactionFailure(
    target,
    name.includes("timeout") || name.includes("abort") || message.includes("timed out") || message.includes("timeout")
      ? "timeout"
      : "network"
  );
}

export function describeCompactionFailure(target) {
  const failure = target && typeof target === "object" ? compactionFailures.get(target) : null;
  if (!failure) return "the provider returned no usable summary";
  const http = failure.status == null ? "" : ` (HTTP ${failure.status})`;
  if (failure.kind === "access") return `provider authentication or account access was rejected${http}`;
  if (failure.kind === "quota") return `the provider quota or billing limit was reached${http}`;
  if (failure.kind === "timeout") return `the provider summarization request timed out${http}`;
  if (failure.kind === "unsupported_endpoint") return `the provider has no compatible summarization endpoint${http}`;
  if (failure.kind === "upstream_unavailable") return `the provider summarization service was unavailable${http}`;
  if (failure.kind === "upstream_rejected") return `the provider rejected the summarization request${http}`;
  if (failure.kind === "invalid_request") return "the compaction request body could not be parsed";
  if (failure.kind === "missing_conversation") return "the request contained no readable conversation text";
  if (failure.kind === "configuration") return "no compatible provider summarization endpoint could be derived";
  if (failure.kind === "network") return "the provider summarization request failed before a response";
  if (failure.kind === "invalid_response") return "the provider response contained no usable summary";
  return "the provider returned no usable summary";
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

export function compactionResponsesUrl(target) {
  const base = String(target?.upstreamBaseUrl || target?.url || "").replace(/\/+$/, "");
  if (!base) return "";
  if (base.endsWith("/v1")) return `${base}/responses`;
  if (base.includes("/v1/")) return `${base.split("/v1/")[0]}/v1/responses`;
  return `${base}/v1/responses`;
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
      const args = typeof item.arguments === "string" && item.arguments.length > 1000
        ? `${item.arguments.slice(0, 1000)}...[truncated]`
        : (item.arguments || "");
      text += `[assistant called function]: ${item.name || ""} with arguments ${args}\n\n`;
    } else if (item.type === "function_call_output") {
      const rawOutput = typeof item.output === "string" ? item.output : String(item.output ?? "");
      const out = rawOutput.length > 2500
        ? `${rawOutput.slice(0, 2500)}...[output truncated for summarization]`
        : rawOutput;
      text += `[function output]: ${out}\n\n`;
    }
  }
  const trimmed = text.trim();
  // Keep the summarization prompt small enough that even the slowest upstream
  // finishes within the proxy watchdog. 80k chars is comfortably under the
  // budget for a structured summary and ~3-4x faster to summarize end-to-end.
  const maxSafeChars = 80000;
  if (trimmed.length > maxSafeChars) {
    const headChars = 20000;
    const tailChars = 60000;
    return `${trimmed.slice(0, headChars)}\n\n...[intermediate conversation history omitted for compaction budget]...\n\n${trimmed.slice(-tailChars)}`;
  }
  return trimmed;
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
  resetCompactionFailure(target);
  const startTime = Date.now();
  const decoded = decodeProxyJsonBody(body, headers, { alreadyDecoded });
  let parsed = null;
  try { parsed = JSON.parse(decoded.body.toString("utf8")); } catch {
    recordCompactionFailure(target, "invalid_request");
    return null;
  }
  const fallbackModel = typeof options.originalModel === "string" && options.originalModel.trim()
    ? options.originalModel.trim()
    : extractModelFromRequest(parsed) || "gpt-5.6-sol";
  const conversationText = extractCompactConversationText(parsed);
  if (!conversationText) {
    recordCompactionFailure(target, "missing_conversation");
    console.error(`[Proxy Compact Shape] No conversation text found for shape ${shape} on ${target?.url}.`);
    return null;
  }
  const shapeUrl = compactionShapeUrl(target, shape, fallbackModel);
  if (!shapeUrl) {
    recordCompactionFailure(target, "configuration");
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
    const res = await fetchCompactionWithVsllmReasoningRetry(shapeUrl, {
      method: "POST",
      headers: buildJsonRequestHeaders(authHeaders),
      body: JSON.stringify(summarizeBody)
    }, {
      target,
      requestBody: summarizeBody,
      timeoutMs: 60000,
      label: `${shape} shape`
    });
    const summaryText = await readShapeSummarizeResponse({ shape, res });
    if (!summaryText) {
      if (res.status === 200) recordCompactionFailure(target, "invalid_response");
      else recordCompactionHttpFailure(target, res.status);
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
    recordCompactionFetchFailure(target, err);
    console.error(`[Proxy Compact Shape] ${shape} fallback failed:`, err?.message || err);
    return null;
  }
}

// Build a Headers object for a JSON request body, overriding any existing
// Content-Type in `authHeaders`. Using a plain-object spread here would emit
// duplicate `content-type` / `Content-Type` keys that fetch joins with `, `
// (e.g. `application/json, application/json`), which some upstreams reject
// with HTTP 400.
function buildJsonRequestHeaders(authHeaders) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(authHeaders || {})) {
    if (key.toLowerCase() === "content-type") continue;
    if (Array.isArray(value)) {
      headers.set(key, value.join(", "));
    } else {
      headers.set(key, String(value));
    }
  }
  headers.set("Content-Type", "application/json");
  return headers;
}

export async function runLocalCompactionFallback(target, body, headers, alreadyDecoded, sanitizeRequestHeaders, options = {}) {
  resetCompactionFailure(target);
  const startTime = Date.now();
  const completionsUrl = compactionCompletionsUrl(target);
  const responsesEndpointUrl = compactionResponsesUrl(target);
  if (!responsesEndpointUrl && !completionsUrl) {
    recordCompactionFailure(target, "configuration");
    console.error(`[Proxy Local Compaction] Cannot derive an upstream summarization endpoint from ${target?.url}`);
    return null;
  }

  const decoded = decodeProxyJsonBody(body, headers, { alreadyDecoded });
  let parsed = null;
  try {
    parsed = JSON.parse(decoded.body.toString("utf8"));
  } catch (err) {
    recordCompactionFailure(target, "invalid_request");
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

  // Codex compaction reuses the request's own model for provider-compatible
  // summarization. A dedicated compact model id is the wrong choice here — it
  // was sized for the small condensed payload, not the full conversation.
  // Prefer the pre-rewrite original model (the proxy body may already have
  // been remapped to a compact-specific id), falling back to the non-compact
  // remap only when the request omitted a model.
  const fallbackModel = typeof options.originalModel === "string" && options.originalModel.trim()
    ? options.originalModel.trim()
    : typeof parsed?.model === "string" && parsed.model.trim()
      ? parsed.model.trim()
      : remappedProxyRequestModel(parsed?.model || "gpt-5.5", target, { compact: false }) || "gpt-5.5";

  // Claude Code path: send the complete, untruncated transcript for
  // summarization. The fallback path always uses /v1/chat/completions
  // because we reach this code only after the upstream's /v1/messages
  // path failed (the failure handler in provider-proxy.mjs invokes this),
  // so retrying the same shape is wasteful. Chat completions is the most
  // universally supported OpenAI-compatible shape on the same upstream.
  if (claudeFormat) {
    const transcript = claudeCompactionTranscriptText(parsed);
    if (!transcript) {
      recordCompactionFailure(target, "missing_conversation");
      console.error(`[Proxy Local Compaction] Claude compaction request had no transcript text.`);
      return null;
    }
    console.log(`[Proxy Local Compaction] Starting Claude provider summarization on ${completionsUrl}...`);
    const summaryText = await summarizeCompactViaChatCompletions({
      target,
      model: fallbackModel,
      transcript,
      authHeaders,
      buildBody: (body) => applyReasoningEffort(body)
    });
    if (!summaryText.trim()) {
      recordCompactionFailureIfUnset(target, "invalid_response");
      console.error(`[Proxy Local Compaction] chat completions endpoint returned an empty summary.`);
      return null;
    }
    console.log(`[Proxy Local Compaction] Summary successfully generated in ${((Date.now() - startTime) / 1000).toFixed(2)}s. Summary size: ${summaryText.length} chars.`);
    return claudeMessagesCompactionResponse(summaryText, parsed?.model);
  }

  // Summarize a Claude Code /compact transcript via the upstream's
  // /v1/chat/completions endpoint (OpenAI chat completions shape). Used
  // when the upstream speaks OpenAI's chat API rather than Anthropic
  // Messages.
  async function summarizeCompactViaChatCompletions({ target, model, transcript, authHeaders, buildBody }) {
    const completionsUrl = compactionCompletionsUrl(target);
    if (!completionsUrl) return "";
    const completionBody = (buildBody || ((b) => b))({
      model,
      stream: false,
      messages: [{ role: "user", content: transcript }]
    });
    try {
      const res = await fetchCompactionWithVsllmReasoningRetry(completionsUrl, {
        method: "POST",
        headers: buildJsonRequestHeaders(authHeaders),
        body: JSON.stringify(completionBody)
      }, {
        target,
        requestBody: completionBody,
        timeoutMs: 90000,
        label: "chat completions"
      });
      if (res.status !== 200) {
        recordCompactionHttpFailure(target, res.status);
        const errText = await res.text().catch(() => "");
        console.error(`[Proxy Local Compaction] completions endpoint failed with status ${res.status}: ${errText.slice(0, 200)}`);
        return "";
      }
      return await readChatCompletionSummary(res);
    } catch (err) {
      recordCompactionFetchFailure(target, err);
      console.error(`[Proxy Local Compaction] completions endpoint failed:`, err?.message || err);
      return "";
    }
  }

  // Codex local compaction follows the same wire-shape priority as normal
  // Codex requests: /v1/responses first, then /v1/chat/completions only when
  // Responses fails or contains no usable summary. Send the full readable
  // conversation so the summary reflects the complete retained context.
  const conversationText = extractCompactConversationText(parsed);
  if (!conversationText) {
    recordCompactionFailure(target, "missing_conversation");
    console.error(`[Proxy Local Compaction] No conversation text found in compact payload.`);
    return null;
  }
  console.log(`[Proxy Local Compaction Debug] fallbackModel=${fallbackModel}, parsedModel=${parsed?.model}, originalModel=${options.originalModel}, textLen=${conversationText.length}`);
  console.log(`[Proxy Local Compaction] Starting Codex provider summarization on ${responsesEndpointUrl || completionsUrl}...`);
  const userPrompt = `Here is the conversation history to summarize:\n\n${conversationText}`;

  let summaryText = "";

  async function trySummarizeViaResponses() {
    const responsesUrl = responsesEndpointUrl;
    if (!responsesUrl) return "";
    const responsesBody = {
      model: fallbackModel,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `${summarizeSystemPrompt}\n\n${userPrompt}`
            }
          ]
        }
      ],
      max_output_tokens: 1500
    };
    // Keep the same VSLLM reasoning level on the Responses fallback as on
    // Chat Completions. The retry helper below handles a channel that rejects
    // `max`; silently dropping the value would change the user's setting.
    if (isVsllmApiAccount(target?.account, target?.upstreamBaseUrl || target?.url || "")
      && typeof reasoningEffort === "string" && reasoningEffort.trim()) {
      responsesBody.reasoning = {
        effort: reasoningEffort.trim(),
        summary: "auto"
      };
    }
    try {
      console.log(`[Proxy Local Compaction] Attempting summarization on ${responsesUrl} with model ${fallbackModel}...`);
      const responsesRes = await fetchCompactionWithVsllmReasoningRetry(responsesUrl, {
        method: "POST",
        headers: buildJsonRequestHeaders(authHeaders),
        body: JSON.stringify(responsesBody)
      }, {
        target,
        requestBody: responsesBody,
        timeoutMs: 120000,
        label: "Responses"
      });

      if (responsesRes.status === 200) {
        const responsesData = await responsesRes.json().catch(() => null);
        const outputItems = Array.isArray(responsesData?.output) ? responsesData.output : [];
        for (const item of outputItems) {
          if (!item || typeof item !== "object") continue;
          if (item.type === "compaction") {
            const firstContent = Array.isArray(item.content) ? item.content[0] : null;
            const extracted = firstContent?.text || item.text || "";
            const text = String(extracted).trim();
            if (text) return text;
          } else if (item.type === "message") {
            const allParts = Array.isArray(item.content) ? item.content : [];
            const hasNonTextPart = allParts.some((part) => part && typeof part === "object" && part.type && part.type !== "text" && part.type !== "output_text");
            const messageText = allParts
              .filter((part) => part && typeof part === "object" && (part.type === "text" || part.type === "output_text" || part.type === undefined))
              .map((part) => String(part?.text ?? ""))
              .join("\n")
              .trim();
            if (messageText && !hasNonTextPart) return messageText;
          } else if (item.type === "reasoning" && Array.isArray(item.summary)) {
            const summaryPart = item.summary.find((s) => s && typeof s.text === "string" && s.text.trim());
            if (summaryPart && summaryPart.text.trim()) return summaryPart.text.trim();
          }
        }
        recordCompactionFailureIfUnset(target, "invalid_response");
      } else {
        recordCompactionHttpFailure(target, responsesRes.status);
        const errText = await responsesRes.text().catch(() => "");
        console.warn(`[Proxy Local Compaction] responses endpoint with model ${fallbackModel} returned status ${responsesRes.status}: ${errText.slice(0, 150)}`);
      }
    } catch (err) {
      recordCompactionFetchFailure(target, err);
      console.warn(`[Proxy Local Compaction] responses endpoint with model ${fallbackModel} failed: ${err.message}`);
    }
    return "";
  }

  async function trySummarizeViaCompletions() {
    if (!completionsUrl) return "";
    const currentCompletionBody = applyReasoningEffort({
      model: fallbackModel,
      messages: [
        { role: "system", content: summarizeSystemPrompt },
        { role: "user", content: userPrompt }
      ]
    });
    try {
      console.log(`[Proxy Local Compaction] Attempting summarization on ${completionsUrl} with model ${fallbackModel}...`);
      const res = await fetchCompactionWithVsllmReasoningRetry(completionsUrl, {
        method: "POST",
        headers: buildJsonRequestHeaders(authHeaders),
        body: JSON.stringify(currentCompletionBody)
      }, {
        target,
        requestBody: currentCompletionBody,
        timeoutMs: 30000,
        label: "chat completions"
      });

      if (res.status === 200) {
        const text = (await readChatCompletionSummary(res)).trim();
        if (text) return text;
        recordCompactionFailureIfUnset(target, "invalid_response");
      } else {
        recordCompactionHttpFailure(target, res.status);
        const errText = await res.text().catch(() => "");
        console.warn(`[Proxy Local Compaction] completions endpoint with model ${fallbackModel} returned status ${res.status}: ${errText.slice(0, 150)}`);
      }
    } catch (err) {
      recordCompactionFetchFailure(target, err);
      console.warn(`[Proxy Local Compaction] completions endpoint with model ${fallbackModel} failed: ${err.message}`);
    }
    return "";
  }

  if (responsesEndpointUrl) {
    summaryText = await trySummarizeViaResponses();
  }
  if (!summaryText && completionsUrl) {
    console.log(`[Proxy Local Compaction] Responses summarization failed; falling back to Chat Completions endpoint ${completionsUrl}...`);
    summaryText = await trySummarizeViaCompletions();
  }

  if (!summaryText) {
    recordCompactionFailureIfUnset(target, "invalid_response");
    console.error(`[Proxy Local Compaction] All summarization methods failed to generate a summary.`);
    return null;
  }

  console.log(`[Proxy Local Compaction] Summary successfully generated in ${((Date.now() - startTime) / 1000).toFixed(2)}s. Summary size: ${summaryText.length} chars.`);

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
