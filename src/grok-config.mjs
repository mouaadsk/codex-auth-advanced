import path from "node:path";
import { removeTomlTopLevelKeyAndSection } from "./codex-config.mjs";
import { userHome } from "./storage.mjs";

export const grokVsllmProviderSection = "model_providers.vsllm";
export const grokProxyApiKeyMarker = "local-codex-auth-advanced";

export const grokVsllmManagedModels = Object.freeze([
  {
    pickerId: "vsllm-grok-45",
    upstreamModel: "grok-4.5",
    name: "VSLLM Grok 4.5 (Chat Completions)",
    apiBackend: "chat_completions",
    contextWindow: 1_000_000,
    maxCompletionTokens: 65_536,
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "high"
  },
  {
    pickerId: "vsllm-grok-46",
    upstreamModel: "grok-4.6",
    name: "VSLLM Grok 4.6 (Chat Completions)",
    apiBackend: "chat_completions",
    contextWindow: 1_000_000,
    maxCompletionTokens: 65_536,
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "high"
  },
  {
    pickerId: "vsllm-ox-alpha",
    upstreamModel: "stealth/ox-alpha",
    name: "VSLLM Ox Alpha (Chat Completions, Free)",
    apiBackend: "chat_completions",
    contextWindow: 1_048_576,
    maxCompletionTokens: 131_072,
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "high"
  }
]);

function grokReasoningEffortLabel(effort) {
  switch (effort) {
    case "low": return "Low";
    case "medium": return "Medium";
    case "high": return "High";
    case "xhigh": return "X-High";
    default: return effort;
  }
}

function appendGrokReasoningEffortToml(lines, model) {
  if (!Array.isArray(model.reasoningEfforts) || model.reasoningEfforts.length === 0) return;
  lines.push("supports_reasoning_effort = true");
  lines.push(`reasoning_effort = ${JSON.stringify(model.defaultReasoningEffort)}`);
  for (const effort of model.reasoningEfforts) {
    lines.push(`[[model.${model.pickerId}.reasoning_efforts]]`);
    lines.push(`id = ${JSON.stringify(effort)}`);
    lines.push(`value = ${JSON.stringify(effort)}`);
    lines.push(`label = ${JSON.stringify(grokReasoningEffortLabel(effort))}`);
    lines.push(`default = ${effort === model.defaultReasoningEffort}`);
    lines.push("");
  }
}

const legacyManagedGrokSections = new Set([
  grokVsllmProviderSection,
  ...grokVsllmManagedModels.map(({ pickerId }) => `model.${pickerId}`),
  "model.vsllm-grok-4.5",
  "model.vsllm-grok-4.6"
]);

export function defaultGrokHome() {
  const configured = String(process.env.GROK_HOME || "").trim();
  return configured || path.join(userHome(), ".grok");
}

export function grokConfigPath(grokHome = defaultGrokHome()) {
  return path.join(grokHome, "config.toml");
}

export function grokProxyBaseUrl(providerProxyBaseUrl) {
  const base = String(providerProxyBaseUrl || "").trim().replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

export function managedGrokConfigSections(baseUrl) {
  const proxyBaseUrl = grokProxyBaseUrl(baseUrl);
  const lines = [
    `[${grokVsllmProviderSection}]`,
    `base_url = ${JSON.stringify(proxyBaseUrl)}`,
    `api_key = ${JSON.stringify(grokProxyApiKeyMarker)}`,
    ""
  ];
  for (const model of grokVsllmManagedModels) {
    lines.push(
      `[model.${model.pickerId}]`,
      'model_provider = "vsllm"',
      `model = ${JSON.stringify(model.upstreamModel)}`,
      `name = ${JSON.stringify(model.name)}`,
      `description = ${JSON.stringify(`${model.upstreamModel} through codex-auth-advanced proxy using Chat Completions`)}`,
      `api_backend = ${JSON.stringify(model.apiBackend)}`,
      `context_window = ${model.contextWindow}`,
      `max_completion_tokens = ${model.maxCompletionTokens}`,
      ""
    );
    appendGrokReasoningEffortToml(lines, model);
  }
  return lines.join("\n").trimEnd();
}

export function upsertGrokVsllmProxyConfig(toml, baseUrl) {
  const withoutManaged = removeTomlTopLevelKeyAndSection(
    String(toml || ""),
    new Set(),
    legacyManagedGrokSections
  ).trimEnd();
  const managed = managedGrokConfigSections(baseUrl);
  if (!withoutManaged) return `${managed}\n`;
  return `${withoutManaged}\n\n${managed}\n`;
}
