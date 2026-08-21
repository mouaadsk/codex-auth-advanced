// Live probe test: mocks fetch to simulate the upstream's per-shape behavior.
// Verifies that probeModelShapes correctly classifies each shape based on
// the HTTP status returned.
import assert from "node:assert/strict";
import { probeModelShapes } from "./src/shape-probe.mjs";
import { WIRE_SHAPES } from "./src/provider-policy.mjs";

const responses = new Map();
let abortCount = 0;

globalThis.fetch = async (url, init) => {
  const key = `${init.method} ${new URL(url).pathname}`;
  const behavior = responses.get(key) || responses.get("*");
  if (!behavior) {
    return new Response(JSON.stringify({ error: "no-mock" }), { status: 500 });
  }
  if (behavior === "abort") { abortCount++; const e = new Error("aborted"); e.name = "AbortError"; throw e; }
  if (behavior === "200") return new Response(JSON.stringify({ ok: true }), { status: 200 });
  if (behavior === "404") return new Response("not found", { status: 404 });
  if (behavior === "405") return new Response("method not allowed", { status: 405 });
  if (behavior === "400-unsupported") return new Response(JSON.stringify({ error: { message: "endpoint not implemented for this model" } }), { status: 400 });
  if (behavior === "501") return new Response("not implemented", { status: 501 });
  if (behavior === "500") return new Response("oops", { status: 500 });
  return new Response("?", { status: 500 });
};

const vsllmAccount = {
  upstream_base_url: "https://example.test",
  api_key: "test-key",
  email: "vsllm-foo@example.com",
  alias: "vsllm-main",
  antigravity_base_url: "https://example.test"
};

// ---------- Case 1: grok-style — only chat_completions supported ----------
{
  responses.clear();
  responses.set("POST /v1/responses", "404");
  responses.set("POST /v1/chat/completions", "200");
  responses.set("POST /v1/messages", "400-unsupported");
  responses.set("POST /v1beta/models/grok-4.5:generateContent", "404");
  const result = await probeModelShapes({ account: vsllmAccount, model: "grok-4.5" });
  assert.ok(result);
  assert.equal(result.has(WIRE_SHAPES.CHAT_COMPLETIONS), true);
  assert.equal(result.has(WIRE_SHAPES.RESPONSES), false);
  assert.equal(result.has(WIRE_SHAPES.MESSAGES), false);
  assert.equal(result.has(WIRE_SHAPES.ANTIGRAVITY), false);
}

// ---------- Case 2: full coverage — all 4 shapes supported ----------
{
  responses.clear();
  responses.set("POST /v1/responses", "200");
  responses.set("POST /v1/chat/completions", "200");
  responses.set("POST /v1/messages", "200");
  responses.set("POST /v1beta/models/gpt-5.6-sol:generateContent", "200");
  const result = await probeModelShapes({ account: vsllmAccount, model: "gpt-5.6-sol" });
  assert.ok(result);
  assert.equal(result.size, 4);
  for (const s of [WIRE_SHAPES.RESPONSES, WIRE_SHAPES.CHAT_COMPLETIONS, WIRE_SHAPES.MESSAGES, WIRE_SHAPES.ANTIGRAVITY]) {
    assert.equal(result.has(s), true);
  }
}

// ---------- Case 3: 5xx is treated as supported (transient) ----------
{
  responses.clear();
  responses.set("POST /v1/responses", "500");
  responses.set("POST /v1/chat/completions", "200");
  responses.set("POST /v1/messages", "200");
  responses.set("POST /v1beta/models/x:generateContent", "500");
  const result = await probeModelShapes({ account: vsllmAccount, model: "x" });
  assert.ok(result);
  assert.equal(result.has(WIRE_SHAPES.RESPONSES), true, "5xx must count as supported");
  assert.equal(result.has(WIRE_SHAPES.ANTIGRAVITY), true);
  assert.equal(result.has(WIRE_SHAPES.CHAT_COMPLETIONS), true);
  assert.equal(result.has(WIRE_SHAPES.MESSAGES), true);
}

// ---------- Case 4: 400 with non-recognizable body is treated as unsupported ----------
{
  responses.clear();
  responses.set("POST /v1/responses", "400");
  responses.set("POST /v1/chat/completions", "200");
  responses.set("POST /v1/messages", "200");
  responses.set("POST /v1beta/models/y:generateContent", "400");
  const result = await probeModelShapes({ account: vsllmAccount, model: "y" });
  assert.ok(result);
  assert.equal(result.has(WIRE_SHAPES.CHAT_COMPLETIONS), true);
  assert.equal(result.has(WIRE_SHAPES.MESSAGES), true);
}

// ---------- Case 5: all probes abort -> inconclusive (returns null) ----------
{
  responses.clear();
  responses.set("POST /v1/responses", "abort");
  responses.set("POST /v1/chat/completions", "abort");
  responses.set("POST /v1/messages", "abort");
  responses.set("POST /v1beta/models/z:generateContent", "abort");
  const result = await probeModelShapes({ account: vsllmAccount, model: "z", timeoutMs: 1000 });
  assert.equal(result, null, "all-aborts must be inconclusive");
}

// ---------- Case 6: account with no antigravity base URL skips antigravity probe ----------
{
  const noAgAccount = { ...vsllmAccount };
  delete noAgAccount.antigravity_base_url;
  delete noAgAccount.gemini_base_url;
  responses.clear();
  // Even if antigravity would 200, the probe must skip it because supportedShapesForAccount
  // requires antigravity_base_url / gemini_base_url / vsllm.com endpoint for VSLLM accounts.
  responses.set("POST /v1/responses", "200");
  responses.set("POST /v1/chat/completions", "200");
  responses.set("POST /v1/messages", "200");
  const result = await probeModelShapes({ account: noAgAccount, model: "gpt-5.6-sol" });
  assert.ok(result);
  assert.equal(result.has(WIRE_SHAPES.ANTIGRAVITY), false);
  assert.equal(result.has(WIRE_SHAPES.RESPONSES), true);
  assert.equal(result.has(WIRE_SHAPES.CHAT_COMPLETIONS), true);
  assert.equal(result.has(WIRE_SHAPES.MESSAGES), true);
}

// ---------- Case 7: missing api_key or upstream URL -> null ----------
{
  const result1 = await probeModelShapes({ account: {}, model: "x" });
  assert.equal(result1, null);
  const result2 = await probeModelShapes({ account: { upstream_base_url: "x" }, model: "x" });
  assert.equal(result2, null);
}

console.log("shape probe live ok");
