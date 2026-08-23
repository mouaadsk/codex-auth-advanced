import path from "node:path";
import { upsertModelCatalogConfig } from "./codex-config.mjs";
import { ensureCodexAuthAdvancedModelCatalog } from "./codex-model-catalog.mjs";
import {
  defaultGrokHome,
  grokConfigPath,
  grokProxyBaseUrl,
  grokVsllmManagedModels,
  upsertGrokVsllmProxyConfig
} from "./grok-config.mjs";
import {
  encodedClaudeGatewayModelId,
  encodedVsllmClaudeGatewayModelId,
  providerSlugForTarget
} from "./provider-policy.mjs";
import {
  accountConfigPath,
  backupIfExists,
  defaultCodexHome,
  ensureDir,
  readJsonFile,
  readTextFile,
  registryPath,
  rootConfigPath,
  userHome,
  writeTextFilePrivate
} from "./storage.mjs";

export function createClientConfigService({ providerProxy, accountService }) {
  const providerProxyBaseUrl = providerProxy.baseUrl;
  const providerProxyAccountBaseUrl = providerProxy.accountBaseUrl;
  const ensureProviderProxyRunning = providerProxy.ensureRunning;
  const activeApiProxyTarget = accountService.activeApiProxyTarget;
  const activeRegistryAccountFromRegistry = accountService.activeRegistryAccountFromRegistry;
  const reconcileRegistryActiveAccount = accountService.reconcileRegistryActiveAccount;
  const apiKeyProxyConfig = accountService.apiKeyProxyConfig;
  const loadManagedRegistryRecords = accountService.loadManagedRegistryRecords;
  const accountLabel = accountService.accountLabel;

  function activeRegistryAccount(codexHome) {
    return activeRegistryAccountFromRegistry(
      reconcileRegistryActiveAccount(codexHome, readJsonFile(registryPath(codexHome)))
    );
  }

  function ensureActiveAccountConfig(codexHome, registry = null, options = {}) {
    registry = reconcileRegistryActiveAccount(
      codexHome,
      registry || readJsonFile(registryPath(codexHome))
    );
    const active = activeRegistryAccountFromRegistry(registry);
    if (!active || active.auth_mode !== "apikey") {
      return { configured: false, changed: false, reason: active ? "active_account_is_not_api_key" : "no_active_account" };
    }

    const accountConfig = readTextFile(accountConfigPath(codexHome, active.account_key));
    const configPath = rootConfigPath(codexHome);
    const current = readTextFile(configPath);
    if (!current.trim() && !accountConfig.trim()) {
      return { configured: false, changed: false, reason: "missing_codex_config" };
    }

    const modelCatalog = options.configureModelCatalog === true
      ? ensureCodexAuthAdvancedModelCatalog(codexHome, current)
      : null;
    const configuredCurrent = modelCatalog
      ? upsertModelCatalogConfig(current, modelCatalog.catalogPath)
      : current;
    const next = apiKeyProxyConfig(codexHome, accountConfig, configuredCurrent);
    const configChanged = next !== current;
    if (configChanged) {
      ensureDir(path.dirname(configPath));
      if (options.backup === true) backupIfExists(configPath);
      writeTextFilePrivate(configPath, next, 0o600);
    }
    return {
      configured: true,
      changed: configChanged || modelCatalog?.changed === true,
      configChanged,
      modelCatalog,
      account: active,
      configPath,
      baseUrl: providerProxyBaseUrl(codexHome)
    };
  }

  function ensureAllActiveAccountConfigs() {
    for (const group of loadManagedRegistryRecords()) {
      ensureActiveAccountConfig(group.codexHome, group.registry);
    }
  }

  function claudeSettingsPath() {
    return path.join(userHome(), ".claude", "settings.json");
  }

  function claudeGatewayModelsCachePath() {
    return path.join(userHome(), ".claude", "cache", "gateway-models.json");
  }

  async function refreshClaudeGatewayModelCache(codexHome) {
    const cachePath = claudeGatewayModelsCachePath();
    const baseUrl = providerProxyBaseUrl(codexHome);
    try {
      if (!(await ensureProviderProxyRunning({ quiet: true }))) {
        throw new Error("the local provider proxy is not healthy");
      }
      const response = await fetch(`${baseUrl}/v1/models?limit=1000`, {
        headers: {
          authorization: "Bearer codex-auth-advanced-gateway-cache",
          "anthropic-version": "2023-06-01",
          "user-agent": "codex-auth-advanced configure"
        },
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) throw new Error(`the provider proxy returned HTTP ${response.status}`);
      const body = await response.json();
      const seen = new Set();
      const models = (Array.isArray(body?.data) ? body.data : [])
        .map((model) => {
          const id = typeof model?.id === "string" ? model.id.trim() : "";
          if (!id || !/^(claude|anthropic)-/i.test(id) || model?.owned_by !== "vsllm" || seen.has(id)) return null;
          seen.add(id);
          return {
            id,
            display_name: typeof model.display_name === "string" && model.display_name.trim()
              ? model.display_name.trim()
              : id
          };
        })
        .filter(Boolean);
      if (models.length === 0) throw new Error("the provider proxy returned no VSLLM Anthropic-compatible models");

      const existing = readJsonFile(cachePath);
      const unchanged = existing?.baseUrl === baseUrl
        && JSON.stringify(existing?.models || []) === JSON.stringify(models);
      if (!unchanged) {
        ensureDir(path.dirname(cachePath));
        writeTextFilePrivate(cachePath, `${JSON.stringify({
          baseUrl,
          fetchedAt: Date.now(),
          models
        }, null, 2)}\n`, 0o600);
      }
      return { refreshed: true, changed: !unchanged, count: models.length, error: null };
    } catch (error) {
      return {
        refreshed: false,
        changed: false,
        count: 0,
        error: error?.message || String(error)
      };
    }
  }

  function isClaudeModelSelection(value) {
    const normalized = String(value || "").trim().toLowerCase().replace(/\[1m\]$/, "");
    return ["default", "best", "fable", "opus", "sonnet", "haiku", "opusplan"].includes(normalized)
      || normalized.startsWith("claude-")
      || normalized.startsWith("anthropic-");
  }

  function configureGrokBuildClient(codexHome, options = {}) {
    const active = activeRegistryAccount(codexHome);
    if (!active || active.auth_mode !== "apikey") {
      return {
        configured: false,
        changed: false,
        reason: active ? "active_account_is_not_api_key" : "no_active_account",
        account: active
      };
    }

    const target = activeApiProxyTarget(codexHome);
    if (target?.error) {
      return {
        configured: false,
        changed: false,
        reason: "active_account_is_unavailable",
        error: target.error,
        account: active
      };
    }

    const provider = providerSlugForTarget(target, active);
    if (provider !== "vsllm") {
      return {
        configured: false,
        changed: false,
        reason: "active_account_is_not_vsllm",
        provider,
        account: active
      };
    }

    const pinnedBaseUrl = providerProxyAccountBaseUrl(codexHome, active);
    if (!pinnedBaseUrl) {
      return {
        configured: false,
        changed: false,
        reason: "active_account_cannot_be_pinned",
        provider,
        account: active
      };
    }

    const configPath = grokConfigPath(options.grokHome);
    const existingText = readTextFile(configPath);
    const nextText = upsertGrokVsllmProxyConfig(existingText, pinnedBaseUrl);
    const changed = nextText !== existingText;
    if (changed) {
      ensureDir(path.dirname(configPath));
      if (options.backup === true) backupIfExists(configPath);
      writeTextFilePrivate(configPath, nextText, 0o600);
    }
    return {
      configured: true,
      changed,
      account: active,
      provider,
      configPath,
      baseUrl: grokProxyBaseUrl(pinnedBaseUrl),
      models: grokVsllmManagedModels.map(({ pickerId, upstreamModel, name, apiBackend }) => ({
        pickerId,
        upstreamModel,
        name,
        apiBackend
      }))
    };
  }

  async function configureClaudeCodeClient(codexHome) {
    const settingsPath = claudeSettingsPath();
    const existingText = readTextFile(settingsPath);
    let settings = {};
    if (existingText.trim()) {
      try {
        settings = JSON.parse(existingText);
      } catch (error) {
        throw new Error(`Claude Code settings are not valid JSON at ${settingsPath}: ${error?.message || error}`);
      }
      if (!settings || Array.isArray(settings) || typeof settings !== "object") {
        throw new Error(`Claude Code settings must contain a JSON object at ${settingsPath}.`);
      }
    }

    const previousBaseUrl = typeof settings.env?.ANTHROPIC_BASE_URL === "string"
      ? settings.env.ANTHROPIC_BASE_URL.trim()
      : "";
    const env = settings.env && !Array.isArray(settings.env) && typeof settings.env === "object"
      ? { ...settings.env }
      : {};
    const legacyKimiModel = encodedClaudeGatewayModelId("kimi-k3");
    const kimi1mModel = `${encodedVsllmClaudeGatewayModelId("kimi-k3")}[1m]`;
    const isLegacyKimiModel = (value) => [
      "kimi-k3",
      "kimi-k3[1m]",
      legacyKimiModel,
      `${legacyKimiModel}[1m]`
    ].includes(String(value || "").trim().toLowerCase());
    if (isLegacyKimiModel(settings.model)) {
      settings.model = kimi1mModel;
    }
    if (isLegacyKimiModel(env.ANTHROPIC_MODEL)) {
      env.ANTHROPIC_MODEL = kimi1mModel;
    }
    const removedModelOverrides = [];
    if (previousBaseUrl && previousBaseUrl !== providerProxyBaseUrl(codexHome)) {
      for (const key of [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
        "ANTHROPIC_DEFAULT_FABLE_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL"
      ]) {
        if (env[key] != null && !isClaudeModelSelection(env[key])) {
          removedModelOverrides.push(key);
          delete env[key];
        }
      }
    }

    if (env.ANTHROPIC_DEFAULT_SONNET_MODEL === "kimi-k3") delete env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    if (env.ANTHROPIC_DEFAULT_OPUS_MODEL === "grok-4.5") delete env.ANTHROPIC_DEFAULT_OPUS_MODEL;
    const removedDiscoverySuppression = String(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || "") === "1";
    if (removedDiscoverySuppression) delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) {
      env.ANTHROPIC_API_KEY = "codex-auth-advanced";
    }
    env.ANTHROPIC_BASE_URL = providerProxyBaseUrl(codexHome);
    env.ANTHROPIC_DEFAULT_FABLE_MODEL = "claude-fable-5";
    env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
    settings.env = env;

    const nextText = `${JSON.stringify(settings, null, 2)}\n`;
    const settingsChanged = nextText !== existingText;
    if (settingsChanged) {
      ensureDir(path.dirname(settingsPath));
      backupIfExists(settingsPath);
      writeTextFilePrivate(settingsPath, nextText, 0o600);
    }
    const gatewayModelCache = await refreshClaudeGatewayModelCache(codexHome);

    return {
      configured: true,
      changed: settingsChanged || gatewayModelCache.changed,
      settingsPath,
      baseUrl: env.ANTHROPIC_BASE_URL,
      removedModelOverrides,
      removedDiscoverySuppression,
      gatewayModelCache
    };
  }

  async function maybeHandleClientConfigure(argv) {
    const direct = argv[0] === "configure";
    const compatibilityAlias = argv[0] === "client" && argv[1] === "configure";
    if (!direct && !compatibilityAlias) return false;
    const args = direct ? argv.slice(1) : argv.slice(2);
    if (args[0] === "--help" || args[0] === "-h") {
      process.stdout.write([
        "Usage: codex-auth-advanced configure [all|codex|claude|grok]",
        "",
        "  all      Configure Codex, Claude Code, and Grok Build (default).",
        "  codex    Configure Codex to use the active account through the local proxy.",
        "  claude   Configure Claude Code to use the Anthropic gateway and Fable route.",
        "  grok     Configure Grok Build with VSLLM Grok models through the local proxy.",
        ""
      ].join("\n"));
      return true;
    }
    const target = args[0] || "all";
    if (args.length > 1 || !["all", "codex", "claude", "grok"].includes(target)) {
      console.error("Usage: codex-auth-advanced configure [all|codex|claude|grok]");
      process.exit(1);
    }

    const codexHome = defaultCodexHome();
    if (target === "all" || target === "codex") {
      const result = ensureActiveAccountConfig(codexHome, readJsonFile(registryPath(codexHome)), {
        backup: true,
        configureModelCatalog: true
      });
      if (result.configured) {
        process.stdout.write(`Codex: ${result.changed ? "configured" : "already configured"} for ${accountLabel(result.account)} at ${result.baseUrl}.\n`);
        process.stdout.write(`Codex models: ${result.modelCatalog.changed ? "configured" : "already configured"} at ${result.modelCatalog.catalogPath}.\n`);
      } else {
        process.stdout.write(`Codex: skipped (${result.reason.replaceAll("_", " ")}).\n`);
      }
    }

    if (target === "all" || target === "claude") {
      const result = await configureClaudeCodeClient(codexHome);
      process.stdout.write(`Claude Code: ${result.changed ? "configured" : "already configured"} at ${result.baseUrl}.\n`);
      if (result.removedModelOverrides.length > 0) {
        process.stdout.write(`Claude Code: removed stale model overrides: ${result.removedModelOverrides.join(", ")}.\n`);
      }
      if (result.removedDiscoverySuppression) {
        process.stdout.write("Claude Code: removed CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 so gateway models can appear in /model.\n");
      }
      if (result.gatewayModelCache.refreshed) {
        process.stdout.write(`Claude Code: ${result.gatewayModelCache.changed ? "cached" : "already cached"} ${result.gatewayModelCache.count} VSLLM gateway model(s).\n`);
      } else {
        process.stderr.write(`Claude Code: could not refresh VSLLM gateway models (${result.gatewayModelCache.error}).\n`);
      }
    }

    if (target === "all" || target === "grok") {
      const result = configureGrokBuildClient(codexHome, { backup: true, grokHome: defaultGrokHome() });
      if (result.configured) {
        process.stdout.write(`Grok Build: ${result.changed ? "configured" : "already configured"} for ${accountLabel(result.account)} at ${result.baseUrl}.\n`);
        process.stdout.write(`Grok Build: ${result.models.map(({ pickerId }) => pickerId).join(", ")}.\n`);
      } else {
        process.stdout.write(`Grok Build: skipped (${result.reason.replaceAll("_", " ")}).\n`);
      }
    }
    return true;
  }

  async function ensureProviderProxyForActiveApiAccounts() {
    for (const group of loadManagedRegistryRecords()) {
      if (group.registry.active_account_key) {
        await ensureProviderProxyRunning({ quiet: true });
        return;
      }
    }
  }

  return {
    activeRegistryAccount,
    ensureActiveAccountConfig,
    ensureAllActiveAccountConfigs,
    configureClaudeCodeClient,
    configureGrokBuildClient,
    maybeHandleClientConfigure,
    ensureProviderProxyForActiveApiAccounts
  };
}
