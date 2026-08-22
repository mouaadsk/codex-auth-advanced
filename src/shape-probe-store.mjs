// Persistent on-disk cache for per-(provider, model) wire-shape capabilities.
//
// Each provider (vsllm, llmapi, ...) maintains its own capability map so the
// proxy can prune the per-source chain to only the shapes the upstream
// actually serves for a given model. Results are written by the probe runner
// and read at startup so we never re-probe a model we already know about.
//
// File location: $CODEX_HOME/cache/model-shape-capabilities.json
// File permissions: 0600 (private; mirrors other codex auth state).
//
// Schema (version 1):
//   {
//     "version": 1,
//     "providers": {
//       "vsllm": {
//         "grok-4.5":   { "shapes": ["chat_completions"], "probedAtMs": 1724280000000 },
//         "gpt-5.6-sol":{ "shapes": ["responses","chat_completions","messages","antigravity"], "probedAtMs": ... }
//       },
//       "llmapi": { ... }
//     }
//   }

import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonFile, ensureDir } from "./storage.mjs";

const CACHE_FILE_RELATIVE = path.join("cache", "model-shape-capabilities.json");
const CACHE_VERSION = 1;

function defaultCachePath() {
  const codexHome = process.env.CODEX_HOME
    || path.join(process.env.HOME || process.env.USERPROFILE || "", ".codex");
  return path.join(codexHome, CACHE_FILE_RELATIVE);
}

function normalizeShape(shape) {
  if (typeof shape !== "string") return null;
  const trimmed = shape.trim();
  return trimmed ? trimmed : null;
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const shapes = Array.isArray(entry.shapes)
    ? entry.shapes.map(normalizeShape).filter(Boolean)
    : [];
  if (!shapes.length) return null;
  const probedAtMs = Number.isFinite(Number(entry.probedAtMs))
    ? Number(entry.probedAtMs)
    : Date.now();
  const ttlMs = Number.isFinite(Number(entry.ttlMs)) ? Number(entry.ttlMs) : null;
  return { shapes, probedAtMs, ttlMs };
}

function normalizeDocument(doc) {
  if (!doc || typeof doc !== "object") {
    return { version: CACHE_VERSION, providers: {} };
  }
  const providers = {};
  const rawProviders = doc.providers && typeof doc.providers === "object" ? doc.providers : {};
  for (const [providerSlug, models] of Object.entries(rawProviders)) {
    if (!models || typeof models !== "object") continue;
    const cleaned = {};
    for (const [modelId, entry] of Object.entries(models)) {
      const normalized = normalizeEntry(entry);
      if (normalized) cleaned[String(modelId).toLowerCase()] = normalized;
    }
    if (Object.keys(cleaned).length) providers[providerSlug] = cleaned;
  }
  return { version: CACHE_VERSION, providers };
}

export function loadShapeCapabilityCache(cachePath = null) {
  const target = cachePath || defaultCachePath();
  const doc = readJsonFile(target);
  return normalizeDocument(doc);
}

export function saveShapeCapabilityCache(doc, cachePath = null) {
  const target = cachePath || defaultCachePath();
  const normalized = normalizeDocument(doc);
  ensureDir(path.dirname(target));
  writeJsonFile(target, normalized);
  return normalized;
}

export function upsertShapeCapability({ providerSlug, model, supportedShapes, ttlMs = null, cachePath = null }) {
  if (!providerSlug || !model) return null;
  const slug = String(providerSlug).toLowerCase().trim();
  const modelId = String(model).toLowerCase().trim();
  if (!slug || !modelId) return null;
  const shapes = Array.isArray(supportedShapes)
    ? supportedShapes.map(normalizeShape).filter(Boolean)
    : [];
  if (!shapes.length) return null;
  const doc = loadShapeCapabilityCache(cachePath);
  if (!doc.providers[slug]) doc.providers[slug] = {};
  doc.providers[slug][modelId] = {
    shapes,
    probedAtMs: Date.now(),
    ttlMs: Number.isFinite(Number(ttlMs)) ? Number(ttlMs) : null
  };
  saveShapeCapabilityCache(doc, cachePath);
  return doc.providers[slug][modelId];
}

export function getPersistedShapeCapabilities({ providerSlug, model, cachePath = null }) {
  if (!providerSlug || !model) return null;
  const slug = String(providerSlug).toLowerCase().trim();
  const modelId = String(model).toLowerCase().trim();
  const baseId = modelId.split(/[\[\(]/)[0];
  const doc = loadShapeCapabilityCache(cachePath);
  const provider = doc.providers[slug];
  if (!provider) return null;
  const entry = provider[baseId] || provider[modelId];
  return entry ? { ...entry, shapes: [...entry.shapes] } : null;
}

export function clearPersistedShapeCapabilities({ providerSlug = null, model = null, cachePath = null } = {}) {
  const doc = loadShapeCapabilityCache(cachePath);
  if (!providerSlug) {
    doc.providers = {};
  } else {
    const slug = String(providerSlug).toLowerCase().trim();
    if (!model) {
      delete doc.providers[slug];
    } else {
      const modelId = String(model).toLowerCase().trim();
      const baseId = modelId.split(/[\[\(]/)[0];
      if (doc.providers[slug]) {
        delete doc.providers[slug][baseId];
        delete doc.providers[slug][modelId];
        if (!Object.keys(doc.providers[slug]).length) delete doc.providers[slug];
      }
    }
  }
  saveShapeCapabilityCache(doc, cachePath);
  return doc;
}

// Test-only: purge the on-disk file.
export function _deleteShapeCapabilityCacheFile(cachePath = null) {
  const target = cachePath || defaultCachePath();
  try { fs.rmSync(target, { force: true }); } catch { /* ignore */ }
}
