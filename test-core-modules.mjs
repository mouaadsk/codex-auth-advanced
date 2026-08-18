import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  apiKeySessionConfigKeys,
  apiKeyTemplate,
  defaultApiKeyConfig,
  inferApiKeyTemplateName,
  mergeApiRuntimeConfig,
  mergeSessionModelConfig,
  parseTomlString,
  topLevelTomlValues,
  upsertModelCatalogConfig,
  upsertOpenAiProviderConfig
} from "./src/codex-config.mjs";
import {
  augmentedCodexModelCatalog,
  vsllmCodexModelSlugs
} from "./src/codex-model-catalog.mjs";
import {
  accountAuthPath,
  backupIfExists,
  ensureDir,
  pathContains,
  readJsonFile,
  readTextFile,
  writeJsonFile,
  writeTextFilePrivate
} from "./src/storage.mjs";
import {
  canonicalizeVsllmProviderBaseUrl,
  canonicalizeVsllmProviderOrigin,
  modelsEndpointFromBaseUrl,
  normalizeProviderOrigin,
  providerDashboardOriginMatchesModelsEndpoint
} from "./src/provider-client.mjs";
import {
  apiProviderExhaustionReason,
  apiProviderTransientRetryReason,
  encodedClaudeGatewayModelId,
  encodedVsllmClaudeGatewayModelId,
  isVsllmApiAccount,
  isVsllmClaudeGatewayModelId,
  parseProviderUsageDetails,
  parseVsllmSubscriptionSelf,
  remappedProxyRequestModel,
  resolvedClaudeGatewayModelId,
  rollingApiSpendFromTotal
} from "./src/provider-policy.mjs";
import {
  normalizeCompactionResponse,
  repairProviderProxyBodyPlaintext,
  rewriteProviderProxyRequestBody
} from "./src/proxy-transforms.mjs";
import { createProviderProxy } from "./src/provider-proxy.mjs";
import { createAccountService } from "./src/account-service.mjs";
import {
  grokProxyBaseUrl,
  upsertGrokVsllmProxyConfig
} from "./src/grok-config.mjs";
import { createClientConfigService } from "./src/client-config.mjs";
import { createCliService } from "./src/cli-service.mjs";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-advanced-core-"));

try {
  const accountsDir = path.join(tempRoot, "accounts");
  ensureDir(accountsDir);

  const jsonPath = path.join(accountsDir, "registry.json");
  writeJsonFile(jsonPath, { active_account_key: "primary" });
  assert.deepEqual(readJsonFile(jsonPath), { active_account_key: "primary" });
  assert.equal(fs.statSync(jsonPath).mode & 0o777, 0o600);

  writeTextFilePrivate(jsonPath, "replacement\n");
  assert.equal(readTextFile(jsonPath), "replacement\n");
  backupIfExists(jsonPath);
  assert.equal(
    fs.readdirSync(accountsDir).filter((name) => name.startsWith("registry.json.bak.")).length,
    1
  );

  const encodedAccountPath = accountAuthPath(tempRoot, "../unsafe/account");
  assert.equal(path.dirname(encodedAccountPath), accountsDir);
  assert.equal(pathContains(tempRoot, encodedAccountPath), true);
  assert.equal(pathContains(accountsDir, tempRoot), false);

  const sourceToml = [
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "max"',
    "model_context_window = 1000000",
    "",
    "[features]",
    "multi_agent = true",
    ""
  ].join("\n");
  const targetToml = [
    'model = "gpt-5.5"',
    'review_model = "gpt-5.5"',
    "model_context_window = 320000",
    "",
    "[model_providers.OpenAI]",
    'base_url = "https://old.example/v1"',
    ""
  ].join("\n");

  const mergedSession = mergeSessionModelConfig(targetToml, sourceToml);
  const sessionValues = topLevelTomlValues(mergedSession, apiKeySessionConfigKeys);
  assert.equal(sessionValues.get("model"), '"gpt-5.6-sol"');
  assert.equal(sessionValues.get("review_model"), '"gpt-5.5"');
  assert.equal(sessionValues.get("model_reasoning_effort"), '"max"');

  const mergedRuntime = mergeApiRuntimeConfig(mergedSession, sourceToml);
  assert.match(mergedRuntime, /^model_context_window = 1000000$/m);

  const proxied = upsertOpenAiProviderConfig(mergedRuntime, "http://127.0.0.1:47778/proxy");
  assert.match(proxied, /^model_provider = "openai"$/m);
  assert.match(proxied, /^openai_base_url = "http:\/\/127\.0\.0\.1:47778\/proxy"$/m);
  assert.doesNotMatch(proxied, /\[model_providers\.OpenAI\]/);
  assert.match(proxied, /^model = "gpt-5\.6-sol"$/m);

  const catalogConfig = upsertModelCatalogConfig(proxied, "/tmp/codex-auth-advanced-models.json");
  assert.match(catalogConfig, /^model_catalog_json = "\/tmp\/codex-auth-advanced-models\.json"$/m);
  assert.equal(
    upsertModelCatalogConfig(catalogConfig, "/tmp/codex-auth-advanced-models.json"),
    catalogConfig
  );

  const baseCatalog = {
    models: vsllmCodexModelSlugs.map((slug, index) => ({
      slug,
      display_name: slug.replace("gpt-", "GPT-").replaceAll("-", " "),
      description: `base model ${index}`,
      supported_reasoning_levels: [{ effort: index === 2 ? "max" : "ultra" }],
      model_messages: { instructions_template: `instructions ${index}` },
      visibility: "list"
    })).concat({
      slug: "gpt-5.6-sol-pro20x",
      display_name: "Retired Sol Pro20x",
      supported_reasoning_levels: [{ effort: "ultra" }]
    })
  };
  const augmentedCatalog = augmentedCodexModelCatalog(baseCatalog);
  assert.deepEqual(
    augmentedCatalog.models.map(({ slug }) => slug),
    vsllmCodexModelSlugs
  );

  const generated = defaultApiKeyConfig("https://vsllm.example/v1", sourceToml, "openai");
  assert.match(generated, /^model = "gpt-5\.6-sol"$/m);
  assert.match(generated, /^model_context_window = 320000$/m);
  assert.equal(parseTomlString('"gpt-5.6-sol"'), "gpt-5.6-sol");
  assert.equal(inferApiKeyTemplateName({ alias: "my tcdmx account" }), "tcdmx");
  assert.equal(inferApiKeyTemplateName({ alias: "llmapi-main" }), "llmapi");
  assert.equal(inferApiKeyTemplateName({}, "https://llmapi.pro/v1"), "llmapi");
  assert.equal(apiKeyTemplate("llmapi")?.baseUrl, "https://llmapi.pro/v1");
  assert.equal(isVsllmApiAccount({ alias: "llmapi" }, "https://llmapi.pro/v1/models"), true);
  assert.equal(isVsllmApiAccount({ alias: "custom-relay" }, "https://llmapi.pro/v1/models"), true);

  const llmapiUsage = parseProviderUsageDetails({
    plan: "max",
    five_hour: {
      used: 3,
      limit: 2000,
      remaining: 1997,
      reset_at: "2026-08-17T23:25:29.755Z"
    },
    week: {
      used: 3,
      limit: 10000,
      remaining: 9997,
      reset_at: "2026-08-24T18:25:29.755Z"
    }
  });
  assert.equal(llmapiUsage.spend, 3);
  assert.equal(llmapiUsage.daily, 3);
  assert.equal(llmapiUsage.limitUsd, 2000);
  assert.equal(llmapiUsage.remaining, 1997);
  assert.equal(llmapiUsage.spendWindowMinutes, 300);
  assert.equal(llmapiUsage.exhausted, false);
  assert.ok(Number.isFinite(llmapiUsage.resetsAt));
  assert.equal(
    providerDashboardOriginMatchesModelsEndpoint("https://vsllm.com/v1/models", "https://vsllm.com"),
    true
  );
  assert.equal(
    providerDashboardOriginMatchesModelsEndpoint("https://vsllm.com/v1/models", "https://api.example.com"),
    false
  );
  assert.equal(
    providerDashboardOriginMatchesModelsEndpoint("https://api.example.com/v1/models", "https://example.com"),
    false
  );
  assert.equal(canonicalizeVsllmProviderOrigin("https://vsllm.com"), "https://api.vsllm.com");
  assert.equal(canonicalizeVsllmProviderOrigin("https://api.vsllm.com"), "https://api.vsllm.com");
  assert.equal(canonicalizeVsllmProviderOrigin("https://api.example.com"), "https://api.example.com");
  assert.equal(canonicalizeVsllmProviderBaseUrl("https://vsllm.com/v1/"), "https://api.vsllm.com/v1");
  assert.equal(canonicalizeVsllmProviderBaseUrl("https://api.vsllm.com/v1/"), "https://api.vsllm.com/v1");
  assert.equal(canonicalizeVsllmProviderBaseUrl("https://api.example.com/v1"), "https://api.example.com/v1");

  const nowSeconds = 2_000_000;
  const subscription = parseVsllmSubscriptionSelf({
    success: true,
    data: {
      billing_preference: "subscription_only",
      subscriptions: [{
        subscription: {
          id: 20,
          plan_id: 13,
          status: "active",
          start_time: nowSeconds - 100,
          end_time: nowSeconds + 10_000,
          last_reset_time: nowSeconds - 3_600,
          next_reset_time: nowSeconds + 25_200,
          used_percent: 40,
          consume_priority: 0
        }
      }]
    }
  }, nowSeconds);
  assert.equal(subscription.planId, 13);
  assert.equal(subscription.windowMinutes, 480);
  assert.equal(subscription.exhausted, false);

  const vsllmAccount = { alias: "vsllm-2", api_spend_limit_usd: 55 };
  assert.equal(
    apiProviderTransientRetryReason(429, { error: { message: "You've hit your usage limit. Try again later." } }, vsllmAccount),
    "vsllm_usage_limit"
  );
  assert.equal(
    apiProviderTransientRetryReason(503, { error: { code: "server_is_overloaded" } }, vsllmAccount),
    "model_capacity"
  );
  assert.equal(
    apiProviderTransientRetryReason(403, { error: { message: "IP access denied by API-Key restriction" } }, vsllmAccount),
    "api_key_restriction"
  );
  assert.equal(
    apiProviderTransientRetryReason(403, { error: { message: "Access denied by API-Key restrictions" } }, vsllmAccount),
    "api_key_restriction"
  );
  assert.equal(
    apiProviderTransientRetryReason(403, { error: { message: "Access denied by API-Key restrictions" } }, { alias: "other-provider" }),
    null
  );
  assert.equal(
    apiProviderExhaustionReason(403, { error: { message: "insufficient balance" } }, vsllmAccount),
    null
  );
  assert.equal(
    apiProviderExhaustionReason(402, { error: { message: "no active subscription" } }, vsllmAccount),
    "no_active_subscription"
  );
  const llmapiAccount = { alias: "llmapi", api_template: "llmapi" };
  assert.equal(
    apiProviderExhaustionReason(403, { error: { message: "Quota exhausted. Please wait for reset or upgrade." } }, llmapiAccount),
    "quota_exhausted"
  );
  assert.equal(
    apiProviderExhaustionReason(429, { error: { message: "window/quota limit reached" } }, llmapiAccount),
    "rate_limit"
  );
  assert.equal(
    remappedProxyRequestModel("gpt-5.6-terra", { account: vsllmAccount }),
    null
  );
  assert.equal(
    remappedProxyRequestModel("gpt-5.6-terra-pro20x", { account: vsllmAccount }),
    "gpt-5.6-terra"
  );
  assert.equal(
    remappedProxyRequestModel("gpt-5.2", { account: vsllmAccount }, { compact: true }),
    "gpt-5.5-openai-compact"
  );
  assert.equal(
    remappedProxyRequestModel("gpt-5.2", { account: vsllmAccount }),
    "gpt-5.5"
  );
  assert.equal(
    remappedProxyRequestModel("gpt-5.5-pro20x", { account: vsllmAccount }, { compact: true }),
    "gpt-5.5-openai-compact"
  );
  assert.equal(
    remappedProxyRequestModel("grok-4.5[1m]", { account: vsllmAccount }),
    "grok-4.5"
  );
  assert.equal(
    remappedProxyRequestModel("grok-4.6[1m]", { account: vsllmAccount }),
    "grok-4.6"
  );
  assert.equal(
    remappedProxyRequestModel("kimi-k3[1m]", { account: vsllmAccount }),
    "kimi-k3"
  );
  assert.equal(encodedClaudeGatewayModelId("kimi-k3"), "claude-fable-5-dd-3k-imik");
  assert.equal(encodedClaudeGatewayModelId("grok-4.5"), "claude-fable-5-dd-5.4-korg");
  assert.equal(encodedClaudeGatewayModelId("grok-4.6"), "claude-fable-5-dd-6.4-korg");
  const namespacedVsllmFable = encodedVsllmClaudeGatewayModelId("claude-fable-5");
  assert.match(namespacedVsllmFable, /^claude-vsllm-/);
  assert.equal(resolvedClaudeGatewayModelId(namespacedVsllmFable), "claude-fable-5");
  assert.equal(isVsllmClaudeGatewayModelId(namespacedVsllmFable), true);
  assert.equal(isVsllmClaudeGatewayModelId("claude-fable-5"), false);
  assert.equal(isVsllmClaudeGatewayModelId("claude-fake-5"), true);
  assert.equal(resolvedClaudeGatewayModelId("claude-fable-5-dd-3k-imik"), "kimi-k3");
  assert.equal(resolvedClaudeGatewayModelId("claude-fable-5-dd-3k-imik[1m]"), "kimi-k3[1m]");
  assert.equal(resolvedClaudeGatewayModelId("claude-fable-5-dd-5.4-korg[1m]"), "grok-4.5[1m]");
  assert.equal(resolvedClaudeGatewayModelId("claude-fable-5-dd-6.4-korg[1m]"), "grok-4.6[1m]");

  const grokProxyRoot = "http://127.0.0.1:47778/_codex-auth-advanced/test-group";
  assert.equal(
    grokProxyBaseUrl(grokProxyRoot),
    "http://127.0.0.1:47778/_codex-auth-advanced/test-group/v1"
  );
  const grokConfigured = upsertGrokVsllmProxyConfig([
    "[cli]",
    'installer = "internal"',
    "",
    "[ui]",
    "yolo = false",
    ""
  ].join("\n"), grokProxyRoot);
  assert.match(grokConfigured, /\[model_providers\.vsllm\]/);
  assert.match(grokConfigured, /base_url = "http:\/\/127\.0\.0\.1:47778\/_codex-auth-advanced\/test-group\/v1"/);
  assert.match(grokConfigured, /\[model\.vsllm-grok-45\]/);
  assert.match(grokConfigured, /model = "grok-4.5"/);
  assert.match(grokConfigured, /\[model\.vsllm-grok-46\]/);
  assert.match(grokConfigured, /model = "grok-4.6"/);
  assert.match(grokConfigured, /\[cli\]/);
  assert.match(grokConfigured, /supports_reasoning_effort = true/);
  assert.match(grokConfigured, /\[\[model\.vsllm-grok-46\.reasoning_efforts\]\]/);
  assert.match(grokConfigured, /value = "xhigh"/);
  assert.doesNotMatch(grokConfigured, /\[model\.vsllm-grok-4\.5\]/);
  const grokReconfigured = upsertGrokVsllmProxyConfig(grokConfigured, `${grokProxyRoot}-updated`);
  assert.match(grokReconfigured, /test-group-updated\/v1"/);
  assert.equal(grokReconfigured.match(/\[model\.vsllm-grok-45\]/g)?.length, 1);

  const rolling = rollingApiSpendFromTotal({
    api_spend_window: {
      total_spend_usd: 100,
      samples: [{ at: nowSeconds - 60, spend_usd: 5, total_spend_usd: 100 }]
    }
  }, 107, 480, nowSeconds);
  assert.equal(rolling.spend, 12);
  assert.equal(modelsEndpointFromBaseUrl("https://vsllm.com"), "https://api.vsllm.com/v1/models");
  assert.equal(modelsEndpointFromBaseUrl("https://vsllm.com/v1"), "https://api.vsllm.com/v1/models");
  assert.equal(normalizeProviderOrigin("https://vsllm.com/v1/models"), "https://vsllm.com");

  const compactTarget = {
    account: vsllmAccount,
    url: "https://vsllm.com/v1/responses/compact",
    upstreamBaseUrl: "https://vsllm.com",
    repairInvalidEncryptedContent: true
  };
  const compactRequest = {
    model: "gpt-5.2",
    client_metadata: { session: "remove-me" },
    reasoning: { effort: "xhigh" },
    input: [{
      type: "message",
      role: "user",
      encrypted_content: "old-state",
      content: [{ type: "input_text", text: "keep this" }]
    }]
  };
  const encodedCompact = zlib.gzipSync(Buffer.from(JSON.stringify(compactRequest)));
  const rewrittenCompact = rewriteProviderProxyRequestBody(
    compactTarget,
    encodedCompact,
    { "content-encoding": "gzip" }
  );
  const rewrittenJson = JSON.parse(rewrittenCompact.body.toString("utf8"));
  assert.equal(rewrittenCompact.rewritten, true);
  assert.equal(rewrittenCompact.decoded, true);
  assert.equal(rewrittenJson.model, "gpt-5.5-openai-compact");
  assert.equal(rewrittenJson.client_metadata, undefined);
  assert.equal(rewrittenJson.reasoning.effort, "xhigh");

  const repairRequest = {
    model: "gpt-5.5",
    input: [
      compactRequest.input[0],
      { type: "reasoning", encrypted_content: "drop-reasoning" },
      { type: "message", role: "assistant", encrypted_content: "drop-message" }
    ]
  };
  const repaired = repairProviderProxyBodyPlaintext(
    compactTarget,
    Buffer.from(JSON.stringify(repairRequest))
  );
  const repairedJson = JSON.parse(repaired.body.toString("utf8"));
  assert.equal(repaired.repaired, true);
  assert.deepEqual(repairedJson.input, [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "keep this" }]
  }]);

  const compactResponse = {
    object: "response.compaction",
    messages: [{ type: "message", role: "assistant", content: "summary" }]
  };
  normalizeCompactionResponse(compactResponse);
  assert.equal(compactResponse.type, "response.compaction");
  assert.equal(compactResponse.output, compactResponse.messages);
  assert.deepEqual(compactResponse.messages[0].content, [{ type: "output_text", text: "summary" }]);

  // Codex remote compaction v2 requires exactly one output item; reasoning
  // items and empty phantom messages must be collapsed away.
  const noisyCompactResponse = {
    object: "response.compaction",
    output: [
      { type: "reasoning", summary: [{ type: "summary_text", text: "thinking..." }] },
      { type: "message", role: "assistant", content: [] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "the real summary" }] }
    ]
  };
  normalizeCompactionResponse(noisyCompactResponse);
  assert.equal(noisyCompactResponse.output.length, 1);
  assert.equal(noisyCompactResponse.output, noisyCompactResponse.messages);
  assert.equal(noisyCompactResponse.output[0].type, "message");
  assert.deepEqual(noisyCompactResponse.output[0].content, [{ type: "output_text", text: "the real summary" }]);

  const stringContentNoisy = {
    type: "response.compaction",
    messages: [
      { type: "message", role: "assistant", content: "" },
      { type: "message", role: "assistant", content: "plain string summary" }
    ]
  };
  normalizeCompactionResponse(stringContentNoisy);
  assert.equal(stringContentNoisy.output.length, 1);
  assert.deepEqual(stringContentNoisy.output[0].content, [{ type: "output_text", text: "plain string summary" }]);

  const proxy = createProviderProxy({
    host: "127.0.0.1",
    port: 47778,
    prefix: "/_codex-auth-advanced",
    activeApiProxyTarget: () => null,
    pinnedApiProxyTarget: () => null,
    markApiAccountExhaustedFromProxy: () => null,
    switchFromExhaustedApiAccount: async () => false,
    targetFromTransientApiFailure: async () => null,
    vsllmTransientUsageLimitMaxRetries: 1,
    vsllmTransientUsageLimitRetryDelayMs: 0,
    modelCapacityMaxRetries: 3,
    modelCapacityRetryBaseDelayMs: 0
  });
  const groupId = Buffer.from(path.resolve(tempRoot), "utf8").toString("base64url");
  assert.equal(proxy.groupId(tempRoot), groupId);
  assert.equal(
    proxy.baseUrl(tempRoot),
    `http://127.0.0.1:47778/_codex-auth-advanced/${groupId}`
  );
  assert.equal(
    proxy.accountBaseUrl(tempRoot, { account_key: "account one" }),
    `http://127.0.0.1:47778/_codex-auth-advanced/${groupId}/accounts/account%20one/v1`
  );
  assert.equal(proxy.isBaseUrl(proxy.baseUrl(tempRoot)), true);

  const pinnedRoute = proxy.routeFromIncoming(new URL(
    `http://127.0.0.1:47778/_codex-auth-advanced/${groupId}/accounts/account%20one/v1/responses`
  ));
  assert.equal(pinnedRoute.codexHome, path.resolve(tempRoot));
  assert.equal(pinnedRoute.accountSelector, "account one");
  const routedTarget = proxy.proxyRequestTargetUrl(
    { url: `/_codex-auth-advanced/${groupId}/v1/responses?stream=true` },
    tempRoot,
    { upstreamBaseUrl: "https://vsllm.com", apiKey: "secret", chatgpt: false }
  );
  assert.equal(routedTarget.url, "https://vsllm.com/v1/responses?stream=true");
  assert.deepEqual(proxy.sanitizeRequestHeaders({
    authorization: "Bearer client",
    cookie: "private=1",
    "x-api-key": "client-key",
    "content-encoding": "gzip",
    accept: "application/json"
  }, routedTarget, { omitContentEncoding: true }), {
    accept: "application/json",
    "accept-encoding": "identity",
    authorization: "Bearer secret",
    "user-agent": "codex-auth-advanced-proxy"
  });

  const serviceHome = path.join(tempRoot, "service-codex");
  const serviceAccountsDir = path.join(serviceHome, "accounts");
  ensureDir(serviceAccountsDir);
  const activeAccount = {
    account_key: "apikey-primary",
    alias: "vsllm-primary",
    auth_mode: "apikey",
    created_at: 10
  };
  const exhaustedAccount = {
    account_key: "apikey-exhausted",
    alias: "vsllm-exhausted",
    auth_mode: "apikey",
    api_spend: { exhausted: true },
    created_at: 30
  };
  const fallbackAccount = {
    account_key: "apikey-fallback",
    alias: "vsllm-fallback",
    auth_mode: "apikey",
    created_at: 20
  };
  writeJsonFile(path.join(serviceAccountsDir, "registry.json"), {
    active_account_key: activeAccount.account_key,
    auto_switch: { enabled: true },
    accounts: [activeAccount, exhaustedAccount, fallbackAccount]
  });
  writeJsonFile(path.join(serviceAccountsDir, `${activeAccount.account_key}.auth.json`), {
    auth_mode: "apikey",
    OPENAI_API_KEY: "primary-secret",
    account_key: activeAccount.account_key
  });
  writeTextFilePrivate(path.join(serviceAccountsDir, `${activeAccount.account_key}.config.toml`), [
    'model_provider = "OpenAI"',
    "",
    "[model_providers.OpenAI]",
    'base_url = "https://vsllm.com/v1"',
    'wire_api = "responses"',
    ""
  ].join("\n"));
  writeTextFilePrivate(path.join(serviceHome, "config.toml"), [
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "max"',
    ""
  ].join("\n"));

  const accountService = createAccountService({
    providerProxy: proxy,
    chatgptCodexBaseUrl: "https://chatgpt.com/backend-api/codex"
  });
  assert.equal(
    accountService.activeRegistryAccountFromRegistry(readJsonFile(path.join(serviceAccountsDir, "registry.json"))).account_key,
    activeAccount.account_key
  );
  assert.equal(
    accountService.apiProxyAccountForSelector(serviceHome, "vsllm-primary").account.account_key,
    activeAccount.account_key
  );
  const activeTarget = accountService.activeApiProxyTarget(serviceHome);
  assert.equal(activeTarget.apiKey, "primary-secret");
  assert.equal(activeTarget.upstreamBaseUrl, "https://api.vsllm.com/v1");
  assert.equal(
    accountService.firstUsableSwitchCandidate(readJsonFile(path.join(serviceAccountsDir, "registry.json"))).account_key,
    fallbackAccount.account_key
  );
  assert.equal(accountService.accountShouldAutoSwitch(exhaustedAccount, { auto_switch: { enabled: true } }), true);

  const clientConfig = createClientConfigService({
    providerProxy: proxy,
    accountService,
    claudeProxyAuthMarker: "codex-auth-advanced-local-proxy"
  });
  const configured = clientConfig.ensureActiveAccountConfig(
    serviceHome,
    readJsonFile(path.join(serviceAccountsDir, "registry.json"))
  );
  assert.equal(configured.configured, true);
  assert.match(readTextFile(path.join(serviceHome, "config.toml")), /^model_provider = "openai"$/m);
  assert.match(readTextFile(path.join(serviceHome, "config.toml")), /openai_base_url = "http:\/\/127\.0\.0\.1:47778\//);

  const grokHome = path.join(tempRoot, "grok-home");
  fs.mkdirSync(grokHome, { recursive: true, mode: 0o700 });
  const grokConfiguredClient = clientConfig.configureGrokBuildClient(serviceHome, { grokHome });
  assert.equal(grokConfiguredClient.configured, true);
  assert.equal(grokConfiguredClient.models.length, 2);
  const grokConfig = readTextFile(path.join(grokHome, "config.toml"));
  assert.match(grokConfig, /model = "grok-4.5"/);
  assert.match(grokConfig, /model = "grok-4.6"/);

  writeJsonFile(path.join(serviceAccountsDir, "registry.json"), {
    active_account_key: exhaustedAccount.account_key,
    auto_switch: { enabled: true },
    accounts: [activeAccount, exhaustedAccount, fallbackAccount]
  });
  const daemonEvents = [];
  const daemonAccountService = {
    ...accountService,
    loadManagedGroups: () => [{ name: "default", codexHome: serviceHome }],
    loadManagedRegistryRecords: () => [],
    loadApiKeyAccountsForManagedList: () => [],
    switchToStoredAccount: async (codexHome, account) => {
      daemonEvents.push({ kind: "switch", codexHome, accountKey: account.account_key });
    }
  };
  const daemonCliService = createCliService({
    providerProxy: proxy,
    accountService: daemonAccountService,
    clientConfigService: {
      ensureAllActiveAccountConfigs: () => {},
      ensureProviderProxyForActiveApiAccounts: async () => {
        daemonEvents.push({ kind: "ensure-proxy" });
      }
    },
    writeManagerPidFile: () => {},
    removeManagerPidFile: () => {},
    ensureAutoSwitchManagerRunning: () => {},
    stopAutoSwitchManager: () => {},
    childEnvForArgv: () => process.env,
    exitFromChild: () => {}
  });
  assert.equal(await daemonCliService.maybeHandleDaemon(["daemon", "--once"]), true);
  assert.deepEqual(daemonEvents, [
    { kind: "ensure-proxy" },
    { kind: "switch", codexHome: serviceHome, accountKey: fallbackAccount.account_key }
  ]);

  process.stdout.write("core storage, config, provider, proxy, account, and client modules ok\n");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
