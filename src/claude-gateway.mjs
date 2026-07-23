import {
  encodedVsllmClaudeGatewayModelId,
  isVsllmClaudeGatewayModelId,
  isVsllmApiAccount
} from "./provider-policy.mjs";

const claudeGatewayResponseBridgeModels = new Map([
  ["grok-4.5", {
    contextSuffix: "[1m]",
    maxInputTokens: 1000000,
    maxTokens: 65536,
    description: "through VSLLM's OpenAI Responses compatibility bridge"
  }]
]);

const claudeGatewayKnownContextModels = new Map([
  ["kimi-k3", {
    contextSuffix: "[1m]",
    maxInputTokens: 1000000,
    maxTokens: 65536
  }]
]);

const defaultGatewayModelMetadata = Object.freeze({
  maxInputTokens: 128000,
  maxTokens: 16384
});

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

function modelId(model) {
  return typeof model?.id === "string" ? model.id.trim() : "";
}

function modelSupportsAnthropicMessages(model) {
  return Array.isArray(model?.supported_endpoint_types)
    && model.supported_endpoint_types.some((type) => String(type || "").toLowerCase() === "anthropic");
}

function officialClaudeModels(models) {
  const seen = new Set();
  return (Array.isArray(models) ? models : [])
    .filter((model) => {
      const id = modelId(model);
      if (!/^(claude|anthropic)-/i.test(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((model) => ({
      id: modelId(model),
      object: "model",
      owned_by: model.owned_by || "anthropic",
      type: "model",
      display_name: model.display_name || modelId(model),
      description: model.description || "Official Anthropic model",
      ...(Number.isFinite(Number(model.max_input_tokens)) ? { max_input_tokens: Number(model.max_input_tokens) } : {}),
      ...(Number.isFinite(Number(model.max_tokens)) ? { max_tokens: Number(model.max_tokens) } : {})
    }));
}

function vsllmClaudeGatewayModels(models) {
  const byId = new Map();
  for (const model of Array.isArray(models) ? models : []) {
    const id = modelId(model);
    if (!id || (!modelSupportsAnthropicMessages(model) && !claudeGatewayResponseBridgeModels.has(id))) continue;
    byId.set(id, model);
  }

  return [...byId.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, model]) => {
      const bridgeMetadata = claudeGatewayResponseBridgeModels.get(id);
      const knownContext = claudeGatewayKnownContextModels.get(id);
      const metadata = bridgeMetadata || knownContext || defaultGatewayModelMetadata;
      return {
        id: `${encodedVsllmClaudeGatewayModelId(id)}${metadata.contextSuffix || ""}`,
        object: "model",
        owned_by: "vsllm",
        type: "model",
        display_name: `VSLLM: ${id}`,
        description: `VSLLM ${id} ${bridgeMetadata?.description || "through the Anthropic Messages API"}.`,
        max_input_tokens: metadata.maxInputTokens,
        max_tokens: metadata.maxTokens,
        source_model: id
      };
    });
}

export function claudeGatewayModelsResponse({ officialModels = [], vsllmModels = [] } = {}) {
  const models = [
    ...officialClaudeModels(officialModels),
    ...vsllmClaudeGatewayModels(vsllmModels)
  ];
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
  return claudeGatewayResponseBridgeModels.has(normalized) ? "responses" : null;
}

export function isVsllmClaudeGatewayModel(model) {
  return isVsllmClaudeGatewayModelId(model);
}
