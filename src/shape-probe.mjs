// Per-model wire-shape capability probe.
//
// Talks to the upstream account's wire-shape endpoints with a minimal
// (max_tokens:1) request and records which ones respond 2xx vs which ones
// respond with "endpoint unsupported" style errors (404 / 405 / 400 with
// not_implemented / unknown_route / unsupported_endpoint).
//
// Used by the chain walker to prune the per-source shape chain for models
// the upstream cannot serve on every shape (e.g. grok-4.5 historically
// only spoke /v1/chat/completions on the Grok host).

import { WIRE_SHAPES, supportedShapesForAccount, isShapeFallbackStatus } from "./provider-policy.mjs";

const PROBE_TIMEOUT_MS = 6000;

// Use streaming for the Responses / Chat Completions / Messages probes so
// the model emits the first token quickly (we abort as soon as we have a
// status). Antigravity uses its non-stream endpoint because the streaming
// endpoint only adds SSE framing without making the upstream respond faster
// for max_tokens=1 requests.
const SHAPE_PROBE_BODY = Object.freeze({
  [WIRE_SHAPES.RESPONSES]: (model) => ({
    model,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "." }] }],
    max_output_tokens: 1,
    stream: true
  }),
  [WIRE_SHAPES.CHAT_COMPLETIONS]: (model) => ({
    model,
    messages: [{ role: "user", content: "." }],
    max_tokens: 1,
    stream: true
  }),
  [WIRE_SHAPES.MESSAGES]: (model) => ({
    model,
    max_tokens: 1,
    stream: true,
    messages: [{ role: "user", content: "." }]
  }),
  [WIRE_SHAPES.ANTIGRAVITY]: (model) => ({
    contents: [{ role: "user", parts: [{ text: "." }] }],
    generationConfig: { maxOutputTokens: 1 }
  })
});

const SHAPE_PROBE_PATH = Object.freeze({
  [WIRE_SHAPES.RESPONSES]: "/v1/responses",
  [WIRE_SHAPES.CHAT_COMPLETIONS]: "/v1/chat/completions",
  [WIRE_SHAPES.MESSAGES]: "/v1/messages",
  [WIRE_SHAPES.ANTIGRAVITY]: null // path is /v1beta/models/{m}:generateContent
});

function antigravityPathFor(model) {
  return `/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

function resolveUpstreamBase(account) {
  const candidates = [
    account?.upstream_base_url,
    account?.upstreamBaseUrl,
    account?.base_url,
    account?.baseUrl
  ].filter((v) => typeof v === "string" && v.trim());
  if (!candidates.length) return null;
  return candidates[0].replace(/\/+$/, "");
}

async function probeOneShape({ baseUrl, apiKey, model, shape, signal }) {
  const path = shape === WIRE_SHAPES.ANTIGRAVITY
    ? antigravityPathFor(model)
    : SHAPE_PROBE_PATH[shape];
  if (!path) return { shape, supported: false, reason: "no-path" };
  const url = `${baseUrl}${path}`;
  const body = SHAPE_PROBE_BODY[shape](model);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal
    });
    const status = response.status;
    // Read enough of the body to inspect error patterns; for streaming
    // responses we cancel after a tiny peek so we don't waste model time.
    let snippet = "";
    try {
      const reader = response.body?.getReader?.();
      if (reader) {
        const { value } = await reader.read();
        if (value) snippet = new TextDecoder("utf-8", { fatal: false }).decode(value).slice(0, 1024);
        try { await reader.cancel(); } catch { /* ignore */ }
      } else {
        snippet = (await response.text()).slice(0, 1024);
      }
    } catch {
      // body read failed; rely on status alone
    }
    // 2xx => supported. 4xx/5xx => not supported only if it looks like an
    // "unsupported endpoint / not implemented" error rather than a generic
    // model validation error (which would mean the endpoint exists but the
    // body is wrong). The probe body is intentionally minimal so genuine
    // 400s are usually endpoint-shape rejections.
    if (status >= 200 && status < 300) return { shape, supported: true };
    if (isShapeFallbackStatus(status, snippet ? safeJsonParse(snippet) : null)) {
      return { shape, supported: false, status, reason: "unsupported-shape" };
    }
    // 5xx / transport: treat as supported (assume the endpoint exists; the
    // chain walker will retry on transport failure anyway).
    if (status >= 500) return { shape, supported: true, status, reason: "transient" };
    // 400 with no recognizable unsupported pattern: assume unsupported
    // (the probe body is minimal; if it 400s the endpoint probably can't
    // serve this model).
    return { shape, supported: false, status, reason: "bad-request" };
  } catch (err) {
    if (err?.name === "AbortError") return { shape, supported: false, reason: "timeout" };
    return { shape, supported: false, reason: err?.code || err?.message || "fetch-failed" };
  }
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Probe every wire shape the account supports for a given model.
 * Returns a Set of supported shapes. Empty set means the probe could not
 * determine support (e.g. all requests timed out); callers should treat
 * that as "no information" rather than "no shapes supported".
 *
 * @param {object} options
 * @param {object} options.account      account object with upstream_base_url + api_key
 * @param {string} options.model        upstream model id
 * @param {number} [options.timeoutMs]  total budget across all 4 probes
 * @param {object} [options.supported]  Set of shapes the account supports (skipped if absent)
 */
export async function probeModelShapes({ account, model, timeoutMs = PROBE_TIMEOUT_MS, supported = null }) {
  if (!account || !model) return null;
  const baseUrl = resolveUpstreamBase(account);
  const apiKey = account?.api_key;
  if (!baseUrl || !apiKey) return null;
  const accountSupported = supported || supportedShapesForAccount(account);
  const candidateShapes = [
    WIRE_SHAPES.RESPONSES,
    WIRE_SHAPES.CHAT_COMPLETIONS,
    WIRE_SHAPES.MESSAGES,
    WIRE_SHAPES.ANTIGRAVITY
  ].filter((s) => accountSupported.has(s));
  if (!candidateShapes.length) return new Set();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const results = await Promise.all(candidateShapes.map((shape) =>
      probeOneShape({ baseUrl, apiKey, model, shape, signal: controller.signal })
    ));
    const supported2 = new Set();
    for (const r of results) if (r.supported) supported2.add(r.shape);
    // If every probe returned unsupported we can't trust the result (it might
    // mean the upstream is in a bad state rather than that the model has no
    // shapes). Only return the set if at least one probe succeeded or all
    // probes completed with a clear "unsupported-shape" verdict.
    const allUnsupported = results.every((r) => !r.supported);
    if (allUnsupported && results.some((r) => r.reason === "timeout" || r.reason === "fetch-failed" || r.reason === "transient")) {
      return null; // inconclusive
    }
    return supported2;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
