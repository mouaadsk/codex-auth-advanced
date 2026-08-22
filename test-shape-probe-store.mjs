import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadShapeCapabilityCache,
  saveShapeCapabilityCache,
  upsertShapeCapability,
  getPersistedShapeCapabilities,
  clearPersistedShapeCapabilities,
  _deleteShapeCapabilityCacheFile
} from "./src/shape-probe-store.mjs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shape-probe-store-"));
const cachePath = path.join(tmpRoot, "model-shape-capabilities.json");

function resetCache() {
  try { fs.rmSync(cachePath, { force: true }); } catch { /* ignore */ }
}

// ---------- Empty cache ----------

{
  resetCache();
  const doc = loadShapeCapabilityCache(cachePath);
  assert.deepEqual(doc, { version: 1, providers: {} });
}

// ---------- upsert + read round-trip ----------

{
  resetCache();
  upsertShapeCapability({
    providerSlug: "vsllm",
    model: "grok-4.5",
    supportedShapes: ["chat_completions"],
    cachePath
  });
  const got = getPersistedShapeCapabilities({ providerSlug: "vsllm", model: "grok-4.5", cachePath });
  assert.ok(got);
  assert.deepEqual(got.shapes, ["chat_completions"]);
  assert.ok(got.probedAtMs > 0);
}

// ---------- Multiple providers ----------

{
  resetCache();
  upsertShapeCapability({ providerSlug: "vsllm", model: "grok-4.5", supportedShapes: ["chat_completions"], cachePath });
  upsertShapeCapability({ providerSlug: "llmapi", model: "grok-4.5", supportedShapes: ["responses", "chat_completions", "messages", "antigravity"], cachePath });
  upsertShapeCapability({ providerSlug: "vsllm", model: "gpt-5.6-sol", supportedShapes: ["responses", "chat_completions", "messages", "antigravity"], cachePath });
  const doc = loadShapeCapabilityCache(cachePath);
  assert.equal(Object.keys(doc.providers).length, 2);
  assert.deepEqual(doc.providers.vsllm["grok-4.5"].shapes, ["chat_completions"]);
  assert.deepEqual(doc.providers.llmapi["grok-4.5"].shapes, ["responses", "chat_completions", "messages", "antigravity"]);
  assert.deepEqual(doc.providers.vsllm["gpt-5.6-sol"].shapes.length, 4);
}

// ---------- Suffix stripping on read ----------

{
  resetCache();
  upsertShapeCapability({ providerSlug: "vsllm", model: "grok-4.5", supportedShapes: ["chat_completions"], cachePath });
  const got = getPersistedShapeCapabilities({ providerSlug: "vsllm", model: "grok-4.5[1m]", cachePath });
  assert.ok(got, "suffix-stripped lookup must hit");
  assert.deepEqual(got.shapes, ["chat_completions"]);
}

// ---------- Clear per provider ----------

{
  resetCache();
  upsertShapeCapability({ providerSlug: "vsllm", model: "a", supportedShapes: ["x"], cachePath });
  upsertShapeCapability({ providerSlug: "llmapi", model: "a", supportedShapes: ["y"], cachePath });
  clearPersistedShapeCapabilities({ providerSlug: "vsllm", cachePath });
  assert.equal(getPersistedShapeCapabilities({ providerSlug: "vsllm", model: "a", cachePath }), null);
  assert.notEqual(getPersistedShapeCapabilities({ providerSlug: "llmapi", model: "a", cachePath }), null);
}

// ---------- Clear per (provider, model) ----------

{
  resetCache();
  upsertShapeCapability({ providerSlug: "vsllm", model: "a", supportedShapes: ["x"], cachePath });
  upsertShapeCapability({ providerSlug: "vsllm", model: "b", supportedShapes: ["y"], cachePath });
  clearPersistedShapeCapabilities({ providerSlug: "vsllm", model: "a", cachePath });
  assert.equal(getPersistedShapeCapabilities({ providerSlug: "vsllm", model: "a", cachePath }), null);
  assert.notEqual(getPersistedShapeCapabilities({ providerSlug: "vsllm", model: "b", cachePath }), null);
}

// ---------- Clear all ----------

{
  resetCache();
  upsertShapeCapability({ providerSlug: "vsllm", model: "a", supportedShapes: ["x"], cachePath });
  upsertShapeCapability({ providerSlug: "llmapi", model: "a", supportedShapes: ["y"], cachePath });
  clearPersistedShapeCapabilities({ cachePath });
  assert.equal(getPersistedShapeCapabilities({ providerSlug: "vsllm", model: "a", cachePath }), null);
  assert.equal(getPersistedShapeCapabilities({ providerSlug: "llmapi", model: "a", cachePath }), null);
}

// ---------- Persistence across "restart" (reload from disk) ----------

{
  resetCache();
  upsertShapeCapability({ providerSlug: "vsllm", model: "grok-4.5", supportedShapes: ["chat_completions"], cachePath });
  upsertShapeCapability({ providerSlug: "vsllm", model: "grok-4.6", supportedShapes: ["chat_completions"], cachePath });
  upsertShapeCapability({ providerSlug: "llmapi", model: "grok-4.5", supportedShapes: ["responses", "chat_completions", "messages", "antigravity"], cachePath });
  // Simulate restart by reading from disk again
  const reloaded = loadShapeCapabilityCache(cachePath);
  assert.equal(reloaded.providers.vsllm["grok-4.5"].shapes.length, 1);
  assert.equal(reloaded.providers.vsllm["grok-4.6"].shapes.length, 1);
  assert.equal(reloaded.providers.llmapi["grok-4.5"].shapes.length, 4);
}

// ---------- Malformed cache is normalized, not thrown ----------

{
  resetCache();
  fs.writeFileSync(cachePath, JSON.stringify({
    version: 1,
    providers: {
      vsllm: {
        "good-model": { shapes: ["chat_completions"], probedAtMs: 123 },
        "bad-model": "this should be ignored",
        "empty-shapes-model": { shapes: [], probedAtMs: 100 }
      },
      broken: null,
      "ok-provider": { "m": { shapes: ["responses"], probedAtMs: 1 } }
    }
  }), "utf8");
  const doc = loadShapeCapabilityCache(cachePath);
  assert.ok(doc.providers.vsllm);
  assert.ok(doc.providers.vsllm["good-model"]);
  assert.equal(doc.providers.vsllm["bad-model"], undefined);
  assert.equal(doc.providers.vsllm["empty-shapes-model"], undefined);
  assert.equal(doc.providers.broken, undefined);
  assert.ok(doc.providers["ok-provider"]);
}

// ---------- Missing file => empty doc ----------

{
  _deleteShapeCapabilityCacheFile(cachePath);
  const doc = loadShapeCapabilityCache(cachePath);
  assert.deepEqual(doc, { version: 1, providers: {} });
}

// ---------- Upsert overwrites previous entry for same (provider, model) ----------

{
  resetCache();
  upsertShapeCapability({ providerSlug: "vsllm", model: "grok-4.5", supportedShapes: ["chat_completions"], cachePath });
  upsertShapeCapability({ providerSlug: "vsllm", model: "grok-4.5", supportedShapes: ["responses", "chat_completions", "messages", "antigravity"], cachePath });
  const got = getPersistedShapeCapabilities({ providerSlug: "vsllm", model: "grok-4.5", cachePath });
  assert.deepEqual(got.shapes, ["responses", "chat_completions", "messages", "antigravity"]);
}

// ---------- File permissions (private) ----------

{
  resetCache();
  upsertShapeCapability({ providerSlug: "vsllm", model: "grok-4.5", supportedShapes: ["chat_completions"], cachePath });
  const stat = fs.statSync(cachePath);
  // 0o600 minus umask; assert owner read/write is set, others have nothing
  const mode = stat.mode & 0o777;
  assert.ok((mode & 0o600) === 0o600, `expected owner rw, got ${mode.toString(8)}`);
}

// ---------- Cleanup ----------

{
  _deleteShapeCapabilityCacheFile(cachePath);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log("shape probe store ok");
