import assert from "node:assert/strict";
import {
  createEndpointChainPlanner,
  buildShapeAttempts
} from "./src/endpoint-chain.mjs";
import { WIRE_SHAPES } from "./src/provider-policy.mjs";

const vsllmAccount = {
  account_key: "vsllm-main",
  alias: "vsllm-main",
  email: "vsllm-foo@example.com",
  antigravity_base_url: "https://vsllm.example.com"
};

// ---------- Codex: responses -> chat -> messages -> antigravity ----------

{
  const planner = createEndpointChainPlanner({ sourceShape: WIRE_SHAPES.RESPONSES });
  planner.prime(vsllmAccount);
  const shapes = planner.shapesForAccount(vsllmAccount);
  assert.deepEqual(shapes, [
    WIRE_SHAPES.RESPONSES,
    WIRE_SHAPES.CHAT_COMPLETIONS,
    WIRE_SHAPES.MESSAGES,
    WIRE_SHAPES.ANTIGRAVITY
  ]);
  assert.equal(planner.shouldFailOverToNextShape({ status: 502 }), true);
  assert.equal(planner.shouldFailOverToNextShape({ status: 524 }), true);
  assert.equal(planner.shouldFailOverToNextShape({ status: 504 }), true);
  assert.equal(planner.shouldFailOverToNextShape({ status: 404 }), true);
  assert.equal(planner.shouldFailOverToNextShape({ status: 405 }), true);
  assert.equal(planner.shouldFailOverToNextShape({ status: 200 }), false);
  assert.equal(planner.shouldFailOverToNextShape({ status: 401 }), false);
}

// ---------- Claude Code: messages -> responses -> chat -> antigravity ----------

{
  const planner = createEndpointChainPlanner({ sourceShape: WIRE_SHAPES.MESSAGES });
  planner.prime(vsllmAccount);
  const shapes = planner.shapesForAccount(vsllmAccount);
  assert.deepEqual(shapes, [
    WIRE_SHAPES.MESSAGES,
    WIRE_SHAPES.RESPONSES,
    WIRE_SHAPES.CHAT_COMPLETIONS,
    WIRE_SHAPES.ANTIGRAVITY
  ]);
}

// ---------- Per-model capability pruning: grok only supports chat ----------

{
  const planner = createEndpointChainPlanner({ sourceShape: WIRE_SHAPES.RESPONSES, model: "grok-4.5" });
  planner.prime(vsllmAccount);
  const shapes = planner.shapesForAccount(vsllmAccount);
  // grok only speaks chat_completions — the planner must prune responses/messages/antigravity
  assert.deepEqual(shapes, [WIRE_SHAPES.CHAT_COMPLETIONS]);
}

// ---------- Account without antigravity configured ----------

{
  // VSLLM-shaped account without antigravity base URL
  const accountNoAg = { account_key: "vsllm-no-ag", alias: "vsllm-no-ag", email: "vsllm-no-ag@example.com" };
  const planner = createEndpointChainPlanner({ sourceShape: WIRE_SHAPES.RESPONSES });
  planner.prime(accountNoAg);
  const shapes = planner.shapesForAccount(accountNoAg);
  assert.deepEqual(shapes, [
    WIRE_SHAPES.RESPONSES,
    WIRE_SHAPES.CHAT_COMPLETIONS,
    WIRE_SHAPES.MESSAGES
  ]);
}

// ---------- Chain advancement math: indexOf + +1 ----------

{
  const planner = createEndpointChainPlanner({ sourceShape: WIRE_SHAPES.RESPONSES });
  planner.prime(vsllmAccount);
  const shapes = planner.shapesForAccount(vsllmAccount);
  // Replicates the provider-proxy walker math.
  let cursor = shapes.indexOf(WIRE_SHAPES.RESPONSES);
  assert.equal(shapes[cursor + 1], WIRE_SHAPES.CHAT_COMPLETIONS);
  cursor = shapes.indexOf(WIRE_SHAPES.CHAT_COMPLETIONS);
  assert.equal(shapes[cursor + 1], WIRE_SHAPES.MESSAGES);
  cursor = shapes.indexOf(WIRE_SHAPES.MESSAGES);
  assert.equal(shapes[cursor + 1], WIRE_SHAPES.ANTIGRAVITY);
  cursor = shapes.indexOf(WIRE_SHAPES.ANTIGRAVITY);
  assert.equal(shapes[cursor + 1], undefined, "antigravity is the last shape");
}

// ---------- Per-model + source: messages source + grok still chat-only ----------

{
  const planner = createEndpointChainPlanner({ sourceShape: WIRE_SHAPES.MESSAGES, model: "grok-4.5" });
  planner.prime(vsllmAccount);
  const shapes = planner.shapesForAccount(vsllmAccount);
  assert.deepEqual(shapes, [WIRE_SHAPES.CHAT_COMPLETIONS]);
}

// ---------- Per-model with model that supports all 4: GPT-5 ----------

{
  const planner = createEndpointChainPlanner({ sourceShape: WIRE_SHAPES.RESPONSES, model: "gpt-5.6-sol" });
  planner.prime(vsllmAccount);
  const shapes = planner.shapesForAccount(vsllmAccount);
  assert.deepEqual(shapes, [
    WIRE_SHAPES.RESPONSES,
    WIRE_SHAPES.CHAT_COMPLETIONS,
    WIRE_SHAPES.MESSAGES,
    WIRE_SHAPES.ANTIGRAVITY
  ]);
}

// ---------- buildShapeAttempts: direct call ----------

{
  const attempts = buildShapeAttempts({
    sourceShape: WIRE_SHAPES.RESPONSES,
    account: vsllmAccount,
    isCompact: false,
    model: "gpt-5.6-sol"
  });
  assert.deepEqual(attempts, [
    WIRE_SHAPES.RESPONSES,
    WIRE_SHAPES.CHAT_COMPLETIONS,
    WIRE_SHAPES.MESSAGES,
    WIRE_SHAPES.ANTIGRAVITY
  ]);
}

console.log("endpoint chain planner ok");

import { buildShapeBridge, createShapeSseTransformStream } from "./src/shape-translator.mjs";

// ---------- End-to-end shape failover: Codex /responses -> /chat/completions ----------

const responsesBody = Buffer.from(JSON.stringify({
  model: "gpt-5.6-sol",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }]
}), "utf8");

const target = {
  url: "https://vsllm.example.com/v1/responses",
  upstreamBaseUrl: "https://vsllm.example.com/v1",
  account: vsllmAccount
};

const bridge = buildShapeBridge({
  target,
  sourceShape: WIRE_SHAPES.RESPONSES,
  targetShape: WIRE_SHAPES.CHAT_COMPLETIONS,
  sourceBody: responsesBody
});
assert.ok(bridge, "responses -> chat_completions bridge must build");
assert.equal(bridge.kind, WIRE_SHAPES.CHAT_COMPLETIONS);
assert.ok(bridge.target.url.includes("/v1/chat/completions"));
const bridged = JSON.parse(bridge.body.toString("utf8"));
assert.equal(bridged.model, "gpt-5.6-sol");
assert.ok(Array.isArray(bridged.messages));

// ---------- Same for chat -> messages -> antigravity ----------

const chatBridge = buildShapeBridge({
  target,
  sourceShape: WIRE_SHAPES.CHAT_COMPLETIONS,
  targetShape: WIRE_SHAPES.MESSAGES,
  sourceBody: responsesBody
});
assert.ok(chatBridge);
assert.ok(chatBridge.target.url.includes("/v1/messages"));

const agBridge = buildShapeBridge({
  target,
  sourceShape: WIRE_SHAPES.MESSAGES,
  targetShape: WIRE_SHAPES.ANTIGRAVITY,
  sourceBody: responsesBody
});
assert.ok(agBridge, "messages -> antigravity bridge must build");
assert.equal(agBridge.kind, WIRE_SHAPES.ANTIGRAVITY);
assert.ok(agBridge.target.url.includes(":streamGenerateContent"));
assert.ok(agBridge.target.url.includes("gpt-5.6-sol"));

// ---------- Claude Code path: /messages -> /responses -> /chat -> antigravity ----------

const messagesBody = Buffer.from(JSON.stringify({
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "hi" }]
}), "utf8");

const claudeTarget = { ...target, url: "https://vsllm.example.com/v1/messages" };
const r1 = buildShapeBridge({ target: claudeTarget, sourceShape: WIRE_SHAPES.MESSAGES, targetShape: WIRE_SHAPES.RESPONSES, sourceBody: messagesBody });
assert.ok(r1, "messages -> responses bridge must build");
assert.ok(r1.target.url.includes("/v1/responses"));

const r2 = buildShapeBridge({ target: claudeTarget, sourceShape: WIRE_SHAPES.RESPONSES, targetShape: WIRE_SHAPES.CHAT_COMPLETIONS, sourceBody: messagesBody });
assert.ok(r2, "responses -> chat bridge must build");
assert.ok(r2.target.url.includes("/v1/chat/completions"));

const r3 = buildShapeBridge({ target: claudeTarget, sourceShape: WIRE_SHAPES.CHAT_COMPLETIONS, targetShape: WIRE_SHAPES.ANTIGRAVITY, sourceBody: messagesBody });
assert.ok(r3, "chat -> antigravity bridge must build");
assert.ok(r3.target.url.includes(":streamGenerateContent"));

console.log("endpoint chain bridge ok");

import {
  recordShapeProbeResult,
  clearShapeProbeCache,
  kickOffShapeProbe,
  supportedShapesForModelWithProbe
} from "./src/provider-policy.mjs";

// ---------- Probe-driven pruning: model absent from static map ----------
{
  clearShapeProbeCache();
  const planner = createEndpointChainPlanner({
    sourceShape: WIRE_SHAPES.RESPONSES,
    model: "discovered-model-1"
  });
  planner.prime(vsllmAccount);
  // Without any probe result, the chain walker still uses the full chain.
  assert.deepEqual(planner.shapesForAccount(vsllmAccount), [
    WIRE_SHAPES.RESPONSES, WIRE_SHAPES.CHAT_COMPLETIONS,
    WIRE_SHAPES.MESSAGES, WIRE_SHAPES.ANTIGRAVITY
  ]);
}

// ---------- Probe result prunes the chain (per-provider slug) ----------
{
  clearShapeProbeCache();
  recordShapeProbeResult("vsllm", "discovered-model-1", new Set([
    WIRE_SHAPES.CHAT_COMPLETIONS
  ]));
  const planner = createEndpointChainPlanner({
    sourceShape: WIRE_SHAPES.RESPONSES,
    model: "discovered-model-1"
  });
  // prime with a target whose apiTemplate resolves to "vsllm" slug
  planner.prime(vsllmAccount, { apiTemplate: "vsllm" });
  // Chain walker must prune to chat_completions only.
  const shapes = planner.shapesForAccount(vsllmAccount);
  assert.deepEqual(shapes, [WIRE_SHAPES.CHAT_COMPLETIONS]);
}

// ---------- Per-provider probe isolation ----------
{
  clearShapeProbeCache();
  recordShapeProbeResult("provider-a", "model-X", new Set([WIRE_SHAPES.CHAT_COMPLETIONS]));
  recordShapeProbeResult("provider-b", "model-X", new Set([
    WIRE_SHAPES.RESPONSES, WIRE_SHAPES.CHAT_COMPLETIONS,
    WIRE_SHAPES.MESSAGES, WIRE_SHAPES.ANTIGRAVITY
  ]));
  const plannerA = createEndpointChainPlanner({ sourceShape: WIRE_SHAPES.RESPONSES, model: "model-X" });
  plannerA.prime(vsllmAccount, { apiTemplate: "provider-A" });
  const plannerB = createEndpointChainPlanner({ sourceShape: WIRE_SHAPES.RESPONSES, model: "model-X" });
  plannerB.prime(vsllmAccount, { apiTemplate: "provider-B" });
  assert.deepEqual(plannerA.shapesForAccount(vsllmAccount), [WIRE_SHAPES.CHAT_COMPLETIONS]);
  assert.deepEqual(plannerB.shapesForAccount(vsllmAccount), [
    WIRE_SHAPES.RESPONSES, WIRE_SHAPES.CHAT_COMPLETIONS,
    WIRE_SHAPES.MESSAGES, WIRE_SHAPES.ANTIGRAVITY
  ]);
}

// ---------- Probe-pruned chain walker math: only one shape, no failover possible ----------
{
  clearShapeProbeCache();
  recordShapeProbeResult("vsllm", "chat-only-model", new Set([WIRE_SHAPES.CHAT_COMPLETIONS]));
  const planner = createEndpointChainPlanner({
    sourceShape: WIRE_SHAPES.RESPONSES,
    model: "chat-only-model"
  });
  planner.prime(vsllmAccount, { apiTemplate: "vsllm" });
  const shapes = planner.shapesForAccount(vsllmAccount);
  // Replicates provider-proxy walker: with only 1 shape, the cursor+1 walk has nowhere to go.
  assert.equal(shapes.length, 1);
  assert.equal(shapes[shapes.indexOf(WIRE_SHAPES.CHAT_COMPLETIONS) + 1], undefined);
}

console.log("endpoint chain + probe ok");
