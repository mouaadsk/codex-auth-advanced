import {
  encodedClaudeGatewayModelId,
  isVsllmApiAccount
} from "./provider-policy.mjs";

const claudeGatewayVsllmModels = new Map([
  ["kimi-k3", {
    displayName: "kimi-k3",
    description: "Kimi K3 through VSLLM",
    ownedBy: "moonshot",
    contextSuffix: "[1m]",
    maxInputTokens: 1000000,
    maxTokens: 65536,
    wireApi: "anthropic"
  }],
  ["grok-4.5", {
    displayName: "grok-4.5",
    description: "Grok 4.5 through VSLLM's OpenAI Responses compatibility bridge",
    ownedBy: "xai",
    contextSuffix: "[1m]",
    maxInputTokens: 1000000,
    maxTokens: 65536,
    wireApi: "responses"
  }]
]);

function proxyHeaderValue(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()] ?? headers?.[name.toUpperCase()];
  return Array.isArray(value) ? value.join(", ") : String(value || "");
}

export function isClaudeGatewayModelsRequest(target, headers = {}) {
  if (!isVsllmApiAccount(target?.account, target?.upstreamBaseUrl || target?.url || "")) return false;
  try {
    if (!new URL(target.url).pathname.replace(/\/$/, "").endsWith("/models")) return false;
  } catch {
    return false;
  }
  return proxyHeaderValue(headers, "anthropic-version").length > 0
    || proxyHeaderValue(headers, "user-agent").toLowerCase().startsWith("claude-cli");
}

export function claudeGatewayModelsResponse() {
  const models = [...claudeGatewayVsllmModels.entries()].map(([id, metadata]) => ({
    id: `${encodedClaudeGatewayModelId(id)}${metadata.contextSuffix || ""}`,
    object: "model",
    owned_by: metadata.ownedBy,
    type: "model",
    display_name: metadata.displayName,
    description: metadata.description,
    max_input_tokens: metadata.maxInputTokens,
    max_tokens: metadata.maxTokens
  }));
  return Buffer.from(JSON.stringify({
    data: models,
    has_more: false,
    first_id: models[0]?.id || "",
    last_id: models.at(-1)?.id || ""
  }), "utf8");
}

export function claudeGatewayModelWireApi(model) {
  const normalized = String(model || "")
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/i, "");
  return claudeGatewayVsllmModels.get(normalized)?.wireApi || null;
}
