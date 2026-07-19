import path from "node:path";
import { upsertModelCatalogConfig } from "./codex-config.mjs";
import { ensureCodexAuthAdvancedModelCatalog } from "./codex-model-catalog.mjs";
import { encodedClaudeGatewayModelId } from "./provider-policy.mjs";
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

export function createClientConfigService({ providerProxy, accountService, claudeProxyAuthMarker }) {
  const providerProxyBaseUrl = providerProxy.baseUrl;
  const ensureProviderProxyRunning = providerProxy.ensureRunning;
  const activeRegistryAccountFromRegistry = accountService.activeRegistryAccountFromRegistry;
  const apiKeyProxyConfig = accountService.apiKeyProxyConfig;
  const loadManagedRegistryRecords = accountService.loadManagedRegistryRecords;
  const accountLabel = accountService.accountLabel;

  function activeRegistryAccount(codexHome) {
    return activeRegistryAccountFromRegistry(readJsonFile(registryPath(codexHome)));
  }

  function ensureActiveAccountConfig(codexHome, registry = readJsonFile(registryPath(codexHome)), options = {}) {
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

  function isClaudeModelSelection(value) {
    const normalized = String(value || "").trim().toLowerCase().replace(/\[1m\]$/, "");
    return ["default", "best", "fable", "opus", "sonnet", "haiku", "opusplan"].includes(normalized)
      || normalized.startsWith("claude-")
      || normalized.startsWith("anthropic-");
  }

  function configureClaudeCodeClient(codexHome) {
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
    const kimi1mModel = `${legacyKimiModel}[1m]`;
    if (["kimi-k3", legacyKimiModel].includes(String(settings.model || "").trim())) {
      settings.model = kimi1mModel;
    }
    if (["kimi-k3", legacyKimiModel].includes(String(env.ANTHROPIC_MODEL || "").trim())) {
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
    delete env.ANTHROPIC_API_KEY;
    env.ANTHROPIC_BASE_URL = providerProxyBaseUrl(codexHome);
    env.ANTHROPIC_AUTH_TOKEN = claudeProxyAuthMarker;
    env.ANTHROPIC_DEFAULT_FABLE_MODEL = "claude-fable-5";
    env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
    settings.env = env;

    const nextText = `${JSON.stringify(settings, null, 2)}\n`;
    if (nextText !== existingText) {
      ensureDir(path.dirname(settingsPath));
      backupIfExists(settingsPath);
      writeTextFilePrivate(settingsPath, nextText, 0o600);
    }

    return {
      configured: true,
      changed: nextText !== existingText,
      settingsPath,
      baseUrl: env.ANTHROPIC_BASE_URL,
      removedModelOverrides,
      removedDiscoverySuppression
    };
  }

  async function maybeHandleClientConfigure(argv) {
    const direct = argv[0] === "configure";
    const compatibilityAlias = argv[0] === "client" && argv[1] === "configure";
    if (!direct && !compatibilityAlias) return false;
    const args = direct ? argv.slice(1) : argv.slice(2);
    if (args[0] === "--help" || args[0] === "-h") {
      process.stdout.write([
        "Usage: codex-auth-advanced configure [all|codex|claude]",
        "",
        "  all      Configure Codex and Claude Code (default).",
        "  codex    Configure Codex to use the active account through the local proxy.",
        "  claude   Configure Claude Code to use the Anthropic gateway and Fable route.",
        ""
      ].join("\n"));
      return true;
    }
    const target = args[0] || "all";
    if (args.length > 1 || !["all", "codex", "claude"].includes(target)) {
      console.error("Usage: codex-auth-advanced configure [all|codex|claude]");
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
      const result = configureClaudeCodeClient(codexHome);
      process.stdout.write(`Claude Code: ${result.changed ? "configured" : "already configured"} at ${result.baseUrl}.\n`);
      if (result.removedModelOverrides.length > 0) {
        process.stdout.write(`Claude Code: removed stale model overrides: ${result.removedModelOverrides.join(", ")}.\n`);
      }
      if (result.removedDiscoverySuppression) {
        process.stdout.write("Claude Code: removed CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 so gateway models can appear in /model.\n");
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
    maybeHandleClientConfigure,
    ensureProviderProxyForActiveApiAccounts
  };
}
