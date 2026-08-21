import assert from "node:assert/strict";
import {
  supportedShapesForModel,
  supportedShapesForModelWithProbe,
  recordShapeProbeResult,
  clearShapeProbeCache,
  kickOffShapeProbe
} from "./src/provider-policy.mjs";
import { WIRE_SHAPES } from "./src/provider-policy.mjs";

// ---------- Static map short-circuit ----------

{
  // grok-4.5 is pinned to chat_completions only.
  const s = supportedShapesForModel("grok-4.5");
  assert.ok(s);
  assert.equal(s.has(WIRE_SHAPES.CHAT_COMPLETIONS), true);
  assert.equal(s.has(WIRE_SHAPES.RESPONSES), false);
  assert.equal(s.has(WIRE_SHAPES.MESSAGES), false);
}

// ---------- Cache miss without account key ----------

{
  clearShapeProbeCache();
  // Unknown model with no account key still returns null.
  const s = supportedShapesForModelWithProbe("nonexistent-model-xyz", null);
  assert.equal(s, null);
}

// ---------- Cache fill + read ----------

{
  clearShapeProbeCache();
  recordShapeProbeResult("test-account", "newmodel-1", new Set([WIRE_SHAPES.CHAT_COMPLETIONS]));
  const s = supportedShapesForModelWithProbe("newmodel-1", "test-account");
  assert.ok(s);
  assert.equal(s.size, 1);
  assert.equal(s.has(WIRE_SHAPES.CHAT_COMPLETIONS), true);
}

// ---------- Different accounts have independent caches ----------

{
  clearShapeProbeCache();
  recordShapeProbeResult("acct-A", "newmodel-2", new Set([WIRE_SHAPES.RESPONSES]));
  recordShapeProbeResult("acct-B", "newmodel-2", new Set([WIRE_SHAPES.CHAT_COMPLETIONS]));
  const a = supportedShapesForModelWithProbe("newmodel-2", "acct-A");
  const b = supportedShapesForModelWithProbe("newmodel-2", "acct-B");
  assert.equal(a.has(WIRE_SHAPES.RESPONSES), true);
  assert.equal(a.has(WIRE_SHAPES.CHAT_COMPLETIONS), false);
  assert.equal(b.has(WIRE_SHAPES.CHAT_COMPLETIONS), true);
  assert.equal(b.has(WIRE_SHAPES.RESPONSES), false);
}

// ---------- Suffix stripping: "newmodel-2[1m]" maps to "newmodel-2" ----------

{
  clearShapeProbeCache();
  recordShapeProbeResult("acct-A", "newmodel-2", new Set([WIRE_SHAPES.RESPONSES]));
  const s = supportedShapesForModelWithProbe("newmodel-2[1m]", "acct-A");
  assert.ok(s);
  assert.equal(s.has(WIRE_SHAPES.RESPONSES), true);
}

// ---------- Probe cache wins over static map ----------

{
  clearShapeProbeCache();
  // Record grok-4.5 with all 4 shapes in the cache (the llmapi gateway
  // exposes every shape; the static "grok-4.5 -> chat only" entry is
  // upstream-specific and should not override a fresh probe result).
  recordShapeProbeResult("acct", "grok-4.5", new Set([
    WIRE_SHAPES.RESPONSES, WIRE_SHAPES.CHAT_COMPLETIONS,
    WIRE_SHAPES.MESSAGES, WIRE_SHAPES.ANTIGRAVITY
  ]));
  const s = supportedShapesForModelWithProbe("grok-4.5", "acct");
  assert.equal(s.size, 4, "fresh probe must win over stale static map");
}

// ---------- kickOffShapeProbe dedupes and caches ----------

{
  clearShapeProbeCache();
  let callCount = 0;
  const probeFn = async () => {
    callCount++;
    return new Set([WIRE_SHAPES.CHAT_COMPLETIONS]);
  };
  // First call kicks it off
  const first = kickOffShapeProbe({ accountKey: "probe-acct", model: "lazy-model", probeFn });
  assert.equal(first, true);
  // Second call before completion should be deduped
  const second = kickOffShapeProbe({ accountKey: "probe-acct", model: "lazy-model", probeFn });
  assert.equal(second, false);
  // Wait for the inflight probe to land
  await new Promise((r) => setTimeout(r, 50));
  const s = supportedShapesForModelWithProbe("lazy-model", "probe-acct");
  assert.ok(s);
  assert.equal(s.has(WIRE_SHAPES.CHAT_COMPLETIONS), true);
  assert.equal(callCount, 1, "probe must run exactly once");
  // Now that the result is cached, the kick-off is a no-op
  const third = kickOffShapeProbe({ accountKey: "probe-acct", model: "lazy-model", probeFn });
  assert.equal(third, false);
}

// ---------- kickOffShapeProbe: probe returning null is treated as inconclusive ----------

{
  clearShapeProbeCache();
  let callCount = 0;
  const probeFn = async () => { callCount++; return null; };
  kickOffShapeProbe({ accountKey: "probe-null", model: "indecisive-model", probeFn });
  await new Promise((r) => setTimeout(r, 50));
  const s = supportedShapesForModelWithProbe("indecisive-model", "probe-null");
  assert.equal(s, null);
  // Should be eligible for another probe
  const retried = kickOffShapeProbe({ accountKey: "probe-null", model: "indecisive-model", probeFn });
  assert.equal(retried, true);
  assert.equal(callCount, 1, "first probe ran; second is inflight");
  await new Promise((r) => setTimeout(r, 50));
}

// ---------- clearShapeProbeCache per account ----------

{
  clearShapeProbeCache();
  recordShapeProbeResult("acct-X", "m", new Set([WIRE_SHAPES.RESPONSES]));
  recordShapeProbeResult("acct-Y", "m", new Set([WIRE_SHAPES.RESPONSES]));
  clearShapeProbeCache("acct-X");
  assert.equal(supportedShapesForModelWithProbe("m", "acct-X"), null);
  assert.notEqual(supportedShapesForModelWithProbe("m", "acct-Y"), null);
}

// ---------- Probe result accepts arrays (not just Sets) ----------

{
  clearShapeProbeCache();
  recordShapeProbeResult("acct-array", "m2", [WIRE_SHAPES.MESSAGES]);
  const s = supportedShapesForModelWithProbe("m2", "acct-array");
  assert.ok(s instanceof Set);
  assert.equal(s.has(WIRE_SHAPES.MESSAGES), true);
}

console.log("shape probe cache ok");
