import { spawnSync } from "node:child_process";
import path from "node:path";
import { parseTomlString, topLevelTomlValues } from "./codex-config.mjs";
import {
  ensureDir,
  readJsonFile,
  readTextFile,
  writeTextFilePrivate
} from "./storage.mjs";

export const vsllmCodexModelSlugs = Object.freeze([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna"
]);

// VSLLM retired these IDs. Keep the set so configure removes stale picker entries.
const retiredVsllmPro20xSlugs = new Set([
  "gpt-5.6-sol-pro20x",
  "gpt-5.6-terra-pro20x",
  "gpt-5.6-luna-pro20x"
]);

export function codexAuthAdvancedModelCatalogPath(codexHome) {
  return path.join(codexHome, "model-catalogs", "codex-auth-advanced.json");
}

function assertModelCatalog(catalog, source) {
  if (!catalog || !Array.isArray(catalog.models)) {
    throw new Error(`${source} did not contain a Codex model catalog.`);
  }
  return catalog;
}

export function augmentedCodexModelCatalog(catalog) {
  const source = assertModelCatalog(catalog, "The source catalog");
  const found = new Set();
  const models = [];

  for (const model of source.models) {
    if (!model || typeof model.slug !== "string" || retiredVsllmPro20xSlugs.has(model.slug)) continue;
    models.push(model);
    if (vsllmCodexModelSlugs.includes(model.slug)) found.add(model.slug);
  }

  const missing = vsllmCodexModelSlugs.filter((slug) => !found.has(slug));
  if (missing.length > 0) {
    throw new Error(`The installed Codex model catalog is missing ${missing.join(", ")}. Update Codex before configuring the VSLLM model picker.`);
  }

  return { ...source, models };
}

export function bundledCodexModelCatalog(options = {}) {
  const executable = options.codexExecutable
    || process.env.CODEX_AUTH_ADVANCED_CODEX_EXECUTABLE
    || "codex";
  const child = spawnSync(executable, ["debug", "models", "--bundled"], {
    encoding: "utf8",
    env: options.env || process.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000
  });
  if (child.error) {
    throw new Error(`Could not read the installed Codex model catalog using ${executable}: ${child.error.message}`);
  }
  if (child.signal || (child.status ?? 1) !== 0) {
    const details = String(child.stderr || child.stdout || "").trim();
    throw new Error(`Could not read the installed Codex model catalog using ${executable}${details ? `: ${details}` : "."}`);
  }
  try {
    return assertModelCatalog(JSON.parse(child.stdout), "The installed Codex CLI");
  } catch (error) {
    throw new Error(`The installed Codex CLI returned an invalid model catalog: ${error?.message || error}`);
  }
}

function configuredModelCatalogPath(codexHome, configToml) {
  const value = topLevelTomlValues(configToml, ["model_catalog_json"]).get("model_catalog_json");
  if (!value) return null;
  const configuredPath = parseTomlString(value);
  if (!configuredPath) return null;
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(codexHome, configuredPath);
}

function mergeUnmanagedCustomModels(bundledCatalog, configuredCatalog) {
  if (!configuredCatalog || !Array.isArray(configuredCatalog.models)) return bundledCatalog;
  const bundledSlugs = new Set(bundledCatalog.models.map((model) => model?.slug).filter(Boolean));
  const customModels = configuredCatalog.models.filter((model) => {
    const slug = model?.slug;
    return typeof slug === "string" && !bundledSlugs.has(slug) && !retiredVsllmPro20xSlugs.has(slug);
  });
  if (customModels.length === 0) return bundledCatalog;
  return { ...bundledCatalog, models: [...bundledCatalog.models, ...customModels] };
}

export function ensureCodexAuthAdvancedModelCatalog(codexHome, configToml, options = {}) {
  const bundledCatalog = bundledCodexModelCatalog(options);
  const configuredPath = configuredModelCatalogPath(codexHome, configToml);
  const configuredCatalog = configuredPath ? readJsonFile(configuredPath) : null;
  const catalog = augmentedCodexModelCatalog(
    mergeUnmanagedCustomModels(bundledCatalog, configuredCatalog)
  );
  const catalogPath = codexAuthAdvancedModelCatalogPath(codexHome);
  const nextText = `${JSON.stringify(catalog, null, 2)}\n`;
  const changed = readTextFile(catalogPath) !== nextText;
  if (changed) {
    ensureDir(path.dirname(catalogPath));
    writeTextFilePrivate(catalogPath, nextText, 0o600);
  }
  return { catalogPath, changed, catalog };
}
