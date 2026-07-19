export const apiKeySessionConfigKeys = ["model", "review_model", "model_reasoning_effort"];

const apiKeyRuntimeConfigKeys = [
  "disable_response_storage",
  "network_access",
  "windows_wsl_setup_acknowledged",
  "model_context_window",
  "model_auto_compact_token_limit"
];

export function tomlSectionName(line) {
  const match = String(line || "").trim().match(/^\[([^\]]+)\]$/);
  return match ? match[1] : null;
}

function isTomlSectionLine(line) {
  return tomlSectionName(line) != null;
}

function firstTomlSectionIndex(lines) {
  const index = lines.findIndex(isTomlSectionLine);
  return index === -1 ? lines.length : index;
}

export function tomlKeyValue(line, { requireValue = true } = {}) {
  const pattern = requireValue
    ? /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/
    : /^([A-Za-z0-9_.-]+)\s*=/;
  const match = String(line || "").trim().match(pattern);
  if (!match) return null;
  return {
    key: match[1],
    value: requireValue ? match[2].trim() : null
  };
}

export function topLevelTomlValues(toml, keys) {
  const wanted = new Set(keys);
  const values = new Map();
  let inTopLevel = true;
  for (const rawLine of String(toml || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (isTomlSectionLine(line)) {
      inTopLevel = false;
      continue;
    }
    if (!inTopLevel) continue;
    const item = tomlKeyValue(line);
    if (!item || !wanted.has(item.key)) continue;
    values.set(item.key, item.value);
  }
  return values;
}

function applyTopLevelTomlValues(toml, values, insertKeys = [...values.keys()]) {
  if (!values || values.size === 0) return toml;

  const lines = String(toml || "").split(/\r?\n/);
  const found = new Set();
  let inTopLevel = true;
  const firstSectionIndex = firstTomlSectionIndex(lines);

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (isTomlSectionLine(trimmed)) {
      inTopLevel = false;
      continue;
    }
    if (!inTopLevel) continue;
    const item = tomlKeyValue(trimmed, { requireValue: false });
    if (!item || !values.has(item.key)) continue;
    lines[i] = `${item.key} = ${values.get(item.key)}`;
    found.add(item.key);
  }

  const missing = insertKeys
    .filter((key) => values.has(key) && !found.has(key))
    .map((key) => `${key} = ${values.get(key)}`);
  if (missing.length > 0) {
    lines.splice(firstSectionIndex, 0, ...missing, "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function mergeSessionModelConfig(targetToml, sourceToml) {
  return applyTopLevelTomlValues(
    targetToml,
    topLevelTomlValues(sourceToml, apiKeySessionConfigKeys),
    apiKeySessionConfigKeys
  );
}

export function mergeApiRuntimeConfig(targetToml, sourceToml) {
  return applyTopLevelTomlValues(
    targetToml,
    topLevelTomlValues(sourceToml, apiKeyRuntimeConfigKeys),
    apiKeyRuntimeConfigKeys
  );
}

export function removeTomlTopLevelKeyAndSection(toml, topLevelKeys, sections) {
  const lines = toml.split(/\r?\n/);
  const out = [];
  let currentSection = null;
  let skipSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const sectionName = tomlSectionName(trimmed);
    if (sectionName != null) {
      currentSection = sectionName;
      skipSection = sections.has(currentSection);
      if (skipSection) continue;
    }
    if (skipSection) continue;

    if (currentSection === null) {
      const item = tomlKeyValue(trimmed, { requireValue: false });
      if (item && topLevelKeys.has(item.key)) continue;
    }

    out.push(line);
  }

  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export function upsertOpenAiProviderConfig(toml, baseUrl) {
  const sourceToml = String(toml || "").trim()
    ? String(toml || "")
    : defaultApiKeyConfig(baseUrl, "");
  const withoutOpenAiProvider = removeTomlTopLevelKeyAndSection(
    sourceToml,
    new Set(["model_provider", "openai_base_url"]),
    new Set(["model_providers.OpenAI"])
  ).trimEnd();
  const lines = withoutOpenAiProvider ? withoutOpenAiProvider.split(/\r?\n/) : [];
  const firstSectionIndex = firstTomlSectionIndex(lines);

  const prefix = [
    "model_provider = \"openai\"",
    `openai_base_url = ${JSON.stringify(baseUrl)}`
  ];
  if (firstSectionIndex > 0) prefix.push("");
  lines.splice(firstSectionIndex, 0, ...prefix);
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export function upsertModelCatalogConfig(toml, modelCatalogPath) {
  return applyTopLevelTomlValues(
    toml,
    new Map([["model_catalog_json", JSON.stringify(modelCatalogPath)]]),
    ["model_catalog_json"]
  );
}

function apiKeyContextDefaults(templateName) {
  const template = apiKeyTemplate(templateName);
  return {
    modelContextWindow: Number.isFinite(template?.defaultModelContextWindow) ? template.defaultModelContextWindow : 320000,
    autoCompactTokenLimit: Number.isFinite(template?.defaultAutoCompactTokenLimit) ? template.defaultAutoCompactTokenLimit : 250000
  };
}

export function defaultApiKeyConfig(baseUrl, sourceToml = "", templateName = null) {
  const cleanedBaseUrl = String(baseUrl || "https://api.openai.com/").trim() || "https://api.openai.com/";
  const contextDefaults = apiKeyContextDefaults(templateName);
  return mergeSessionModelConfig([
    'model_provider = "OpenAI"',
    'model = "gpt-5.5"',
    'review_model = "gpt-5.5"',
    'model_reasoning_effort = "xhigh"',
    "disable_response_storage = true",
    'network_access = "enabled"',
    "windows_wsl_setup_acknowledged = true",
    `model_context_window = ${contextDefaults.modelContextWindow}`,
    `model_auto_compact_token_limit = ${contextDefaults.autoCompactTokenLimit}`,
    "",
    "[model_providers.OpenAI]",
    'name = "OpenAI"',
    `base_url = ${JSON.stringify(cleanedBaseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "",
  ].join("\n"), sourceToml);
}

export function apiKeyTemplate(name) {
  const normalized = String(name || "").toLowerCase();
  if (normalized === "openai") {
    return {
      name: "openai",
      baseUrl: "https://api.openai.com/v1",
      defaultSpendLimitUsd: null,
      defaultModelContextWindow: 320000,
      defaultAutoCompactTokenLimit: 250000,
      repairInvalidEncryptedContent: false
    };
  }
  if (normalized === "codex-everywhere" || normalized === "codex_everywhere" || normalized === "everywhere") {
    return {
      name: "codex-everywhere",
      baseUrl: "https://codex-everywhere.com/",
      defaultSpendLimitUsd: 50,
      defaultModelContextWindow: 320000,
      defaultAutoCompactTokenLimit: 250000,
      repairInvalidEncryptedContent: true
    };
  }
  if (normalized === "tcdmx") {
    return {
      name: "tcdmx",
      baseUrl: "https://tcdmx.com",
      defaultSpendLimitUsd: 300,
      defaultModelContextWindow: 320000,
      defaultAutoCompactTokenLimit: 250000,
      repairInvalidEncryptedContent: true
    };
  }
  return null;
}

export function inferApiKeyTemplateName(account, upstreamBaseUrl = "") {
  const explicit = apiKeyTemplate(account?.api_template)?.name;
  if (explicit) return explicit;

  let hostname = "";
  try {
    hostname = new URL(String(upstreamBaseUrl || "")).hostname.toLowerCase();
  } catch {
    hostname = "";
  }
  const label = [account?.alias, account?.email, account?.account_name, account?.account_key]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();

  if (hostname === "tcdmx.com" || label.includes("tcdmx")) return "tcdmx";
  if (hostname === "codex-everywhere.com" || label.includes("codex-everywhere")) return "codex-everywhere";
  return "openai";
}

export function apiKeyTemplateForAccount(account, upstreamBaseUrl = "") {
  return apiKeyTemplate(inferApiKeyTemplateName(account, upstreamBaseUrl));
}

export function parseTomlString(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return trimmed;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed.slice(1, -1);
  }
}

export function tomlLiteralForCli(rawValue) {
  const value = String(rawValue || "").trim();
  return value.length > 0 ? value : null;
}

export function tomlStringForCli(rawValue) {
  const value = tomlLiteralForCli(rawValue);
  if (!value) return null;
  return parseTomlString(value);
}
