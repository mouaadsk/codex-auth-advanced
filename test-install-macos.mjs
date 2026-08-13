import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const repoRoot = new URL(".", import.meta.url).pathname;
const installer = path.join(repoRoot, "scripts", "install-macos.mjs");
const serviceRunner = path.join(repoRoot, "scripts", "run-proxy-service.mjs");
const wrapper = path.join(repoRoot, "bin", "codex-auth-advanced.js");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-advanced-install-"));
const home = path.join(tempRoot, "home");
const codexHome = path.join(home, ".codex");
const accountsDir = path.join(codexHome, "accounts");
const claudeDir = path.join(home, ".claude");
const grokDir = path.join(home, ".grok");
const fakeBin = path.join(tempRoot, "bin");
const proxyPort = 47891;

for (const directory of [accountsDir, claudeDir, grokDir, fakeBin]) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}
const fakeReasoningLevels = ["low", "medium", "high", "xhigh", "max", "ultra"]
  .map((effort) => ({ effort, description: effort }));
const fakeCodexCatalog = {
  models: [
    { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", supported_reasoning_levels: fakeReasoningLevels, visibility: "list", priority: 1 },
    { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", supported_reasoning_levels: fakeReasoningLevels, visibility: "list", priority: 2 },
    { slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", supported_reasoning_levels: fakeReasoningLevels.slice(0, -1), visibility: "list", priority: 3 }
  ]
};
const fakeCodexExecutable = path.join(fakeBin, "codex");
fs.writeFileSync(fakeCodexExecutable, [
  "#!/usr/bin/env node",
  `const catalog = ${JSON.stringify(fakeCodexCatalog)};`,
  "if (process.argv.slice(2).join(' ') === 'debug models --bundled') process.stdout.write(JSON.stringify(catalog));",
  ""
].join("\n"), { mode: 0o755 });
fs.chmodSync(fakeCodexExecutable, 0o755);
const fakeClaudeExecutable = path.join(fakeBin, "claude");
fs.writeFileSync(fakeClaudeExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
fs.chmodSync(fakeClaudeExecutable, 0o755);
const fakeGrokExecutable = path.join(fakeBin, "grok");
fs.writeFileSync(fakeGrokExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
fs.chmodSync(fakeGrokExecutable, 0o755);

fs.writeFileSync(path.join(grokDir, "config.toml"), [
  "[cli]",
  'installer = "internal"',
  "",
  "[ui]",
  "yolo = false",
  ""
].join("\n"), { mode: 0o600 });

const accountKey = "apikey-vsllm-install-test";
fs.writeFileSync(path.join(codexHome, "config.toml"), [
  'model = "gpt-5.6-sol"',
  'review_model = "gpt-5.5"',
  'model_reasoning_effort = "max"',
  'model_provider = "OpenAI"',
  'openai_base_url = "https://old-gateway.example/v1"',
  "",
  "[model_providers.OpenAI]",
  'name = "Old OpenAI provider"',
  'base_url = "https://old-gateway.example/v1"',
  'wire_api = "responses"',
  "",
  "[features]",
  "multi_agent = true",
  ""
].join("\n"), { mode: 0o600 });
fs.writeFileSync(path.join(accountsDir, `${accountKey}.config.toml`), [
  'model_provider = "OpenAI"',
  "",
  "[model_providers.OpenAI]",
  'name = "OpenAI"',
  'base_url = "https://vsllm.com/v1"',
  'wire_api = "responses"',
  'requires_openai_auth = true',
  ""
].join("\n"), { mode: 0o600 });
fs.writeFileSync(path.join(accountsDir, "registry.json"), JSON.stringify({
  active_account_key: accountKey,
  accounts: [{
    account_key: accountKey,
    alias: "mouaad-vsllm",
    email: "mouaad-vsllm",
    auth_mode: "apikey"
  }]
}, null, 2), { mode: 0o600 });

const originalClaudeSettings = {
  effortLevel: "high",
  model: "claude-fable-5-dd-3k-imik[1m]",
  env: {
    ANTHROPIC_BASE_URL: "https://old-gateway.example/anthropic",
    ANTHROPIC_AUTH_TOKEN: "old-token",
    ANTHROPIC_API_KEY: "old-key",
    ANTHROPIC_MODEL: "deepseek-v4-pro[1m]",
    ANTHROPIC_SMALL_FAST_MODEL: "deepseek-v4-flash",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro[1m]",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro[1m]",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
    CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4-flash",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CUSTOM_SETTING_TO_KEEP: "yes"
  },
  enabledPlugins: { example: true }
};
fs.writeFileSync(path.join(claudeDir, "settings.json"), `${JSON.stringify(originalClaudeSettings, null, 2)}\n`, { mode: 0o600 });
const claudeGatewayModelsCachePath = path.join(claudeDir, "cache", "gateway-models.json");
fs.mkdirSync(path.dirname(claudeGatewayModelsCachePath), { recursive: true, mode: 0o700 });
fs.writeFileSync(claudeGatewayModelsCachePath, JSON.stringify({
  baseUrl: originalClaudeSettings.env.ANTHROPIC_BASE_URL,
  models: [{ id: "claude-fable-5-dd-3k-imik[1m]", display_name: "kimi-k3" }]
}), { mode: 0o600 });

function runInstaller() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [installer, "--skip-link", "--skip-service-load"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: codexHome,
        CODEX_AUTH_ADVANCED_PROXY_PORT: String(proxyPort),
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if ((code ?? 1) !== 0 || signal) {
        reject(new Error(`installer failed with ${signal || code}:\n${stdout}\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function runWrapper(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapper, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: codexHome,
        CODEX_AUTH_ADVANCED_PROXY_PORT: String(proxyPort),
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if ((code ?? 1) !== 0 || signal) {
        reject(new Error(`wrapper failed with ${signal || code}:\n${stdout}\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function backupCount(filePath) {
  const directory = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.bak.`;
  return fs.readdirSync(directory).filter((name) => name.startsWith(prefix)).length;
}

const expectedGroupId = Buffer.from(path.resolve(codexHome), "utf8").toString("base64url");
const expectedBaseUrl = `http://127.0.0.1:${proxyPort}/_codex-auth-advanced/${expectedGroupId}`;
const expectedModelCatalogPath = path.join(codexHome, "model-catalogs", "codex-auth-advanced.json");
const gatewayRequests = [];
const gatewayProxy = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/_codex-auth-advanced/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "GET" && req.url === `/_codex-auth-advanced/${expectedGroupId}/v1/models?limit=1000`) {
    gatewayRequests.push({ authorization: req.headers.authorization, anthropicVersion: req.headers["anthropic-version"] });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      data: [
        { id: "claude-vsllm-Y2xhdWRlLWZhYmxlLTU", display_name: "VSLLM: claude-fable-5", owned_by: "vsllm" },
        { id: "claude-vsllm-a2ltaS1rMw[1m]", display_name: "VSLLM: kimi-k3", owned_by: "vsllm" },
        { id: "claude-fable-5", display_name: "Claude Fable 5", owned_by: "anthropic" }
      ]
    }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});
await new Promise((resolve) => gatewayProxy.listen(proxyPort, "127.0.0.1", resolve));
gatewayProxy.unref();
const configureHelp = await runWrapper(["configure", "--help"]);
for (const expected of [
  "Usage: codex-auth-advanced configure [all|codex|claude|grok]",
  "all      Configure Codex, Claude Code, and Grok Build (default).",
  "codex    Configure Codex",
  "claude   Configure Claude Code",
  "grok     Configure Grok Build"
]) {
  if (!configureHelp.stdout.includes(expected)) {
    throw new Error(`configure help is missing ${expected}:\n${configureHelp.stdout}`);
  }
}
const topLevelHelp = await runWrapper(["--help"]);
if (!topLevelHelp.stdout.includes("configure [all|codex|claude|grok]")) {
  throw new Error(`top-level help does not advertise configure:\n${topLevelHelp.stdout}`);
}

const first = await runInstaller();
if (!first.stdout.includes("Codex: configured")
  || !first.stdout.includes("Claude Code: configured")
  || !first.stdout.includes("Grok Build: configured")) {
  throw new Error(`installer did not configure all clients:\n${first.stdout}\n${first.stderr}`);
}
if (!first.stdout.includes("Codex models: configured")) {
  throw new Error(`installer did not configure the Codex model picker:\n${first.stdout}\n${first.stderr}`);
}
if (!first.stdout.includes("removed stale model overrides")) {
  throw new Error(`installer did not report stale Claude model cleanup:\n${first.stdout}`);
}

const codexConfigPath = path.join(codexHome, "config.toml");
const codexConfig = fs.readFileSync(codexConfigPath, "utf8");
for (const expected of [
  'model = "gpt-5.6-sol"',
  'review_model = "gpt-5.5"',
  'model_reasoning_effort = "max"',
  'model_provider = "openai"',
  `openai_base_url = "${expectedBaseUrl}"`,
  `model_catalog_json = "${expectedModelCatalogPath}"`,
  "[features]",
  "multi_agent = true"
]) {
  if (!codexConfig.includes(expected)) throw new Error(`Codex config lost ${expected}:\n${codexConfig}`);
}
if (codexConfig.includes("[model_providers.OpenAI]") || codexConfig.includes("old-gateway.example")) {
  throw new Error(`Codex config retained the obsolete provider block:\n${codexConfig}`);
}
const configuredModelCatalog = JSON.parse(fs.readFileSync(expectedModelCatalogPath, "utf8"));
const configuredModelSlugs = configuredModelCatalog.models.map(({ slug }) => slug);
for (const expected of [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna"
]) {
  if (!configuredModelSlugs.includes(expected)) {
    throw new Error(`Codex model catalog is missing ${expected}: ${configuredModelSlugs.join(", ")}`);
  }
}
if (configuredModelSlugs.some((slug) => /pro[_-]?20x|pro20x/i.test(slug))) {
  throw new Error(`Codex model catalog retained retired Pro20x entries: ${configuredModelSlugs.join(", ")}`);
}

const claudeSettingsPath = path.join(claudeDir, "settings.json");
const claudeSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, "utf8"));
if (claudeSettings.effortLevel !== "high" || claudeSettings.enabledPlugins?.example !== true) {
  throw new Error(`Claude settings lost unrelated values: ${JSON.stringify(claudeSettings)}`);
}
if (claudeSettings.model !== "claude-vsllm-a2ltaS1rMw[1m]") {
  throw new Error(`Claude Kimi selection was not migrated to 1M context: ${JSON.stringify(claudeSettings)}`);
}
if (claudeSettings.env.ANTHROPIC_BASE_URL !== expectedBaseUrl
  || claudeSettings.env.ANTHROPIC_DEFAULT_FABLE_MODEL !== "claude-fable-5"
  || claudeSettings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY !== "1") {
  throw new Error(`Claude proxy settings are incomplete: ${JSON.stringify(claudeSettings.env)}`);
}
if (!claudeSettings.env.ANTHROPIC_API_KEY && !claudeSettings.env.ANTHROPIC_AUTH_TOKEN) {
  throw new Error(`Claude settings missing fallback ANTHROPIC_API_KEY: ${JSON.stringify(claudeSettings.env)}`);
}
for (const stale of [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL"
]) {
  if (claudeSettings.env[stale] != null) throw new Error(`Claude settings retained stale ${stale}`);
}
if (claudeSettings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC != null
  || claudeSettings.env.CUSTOM_SETTING_TO_KEEP !== "yes") {
  throw new Error(`Claude settings lost preserved environment values: ${JSON.stringify(claudeSettings.env)}`);
}
if (fs.existsSync(claudeGatewayModelsCachePath)) {
  const claudeGatewayModelsCache = JSON.parse(fs.readFileSync(claudeGatewayModelsCachePath, "utf8"));
  if (claudeGatewayModelsCache.baseUrl !== expectedBaseUrl
    || JSON.stringify(claudeGatewayModelsCache.models) !== JSON.stringify([
      { id: "claude-vsllm-Y2xhdWRlLWZhYmxlLTU", display_name: "VSLLM: claude-fable-5" },
      { id: "claude-vsllm-a2ltaS1rMw[1m]", display_name: "VSLLM: kimi-k3" }
    ])) {
    throw new Error(`Claude gateway model cache was not refreshed correctly: ${JSON.stringify(claudeGatewayModelsCache)}`);
  }
} else {
  throw new Error("Claude gateway model cache was not created after configuration");
}
if (gatewayRequests.length === 0
  || gatewayRequests.some((request) => request.authorization !== "Bearer codex-auth-advanced-gateway-cache"
    || request.anthropicVersion !== "2023-06-01")) {
  throw new Error(`Claude gateway model cache refresh used invalid proxy credentials: ${JSON.stringify(gatewayRequests)}`);
}

const grokConfigPath = path.join(grokDir, "config.toml");
const grokConfig = fs.readFileSync(grokConfigPath, "utf8");
for (const expected of [
  "[cli]",
  'installer = "internal"',
  "[model_providers.vsllm]",
  `base_url = "${expectedBaseUrl}/v1"`,
  'api_backend = "responses"',
  "[model.vsllm-grok-45]",
  'model = "grok-4.5"',
  "[model.vsllm-grok-46]",
  'model = "grok-4.6"'
]) {
  if (!grokConfig.includes(expected)) throw new Error(`Grok config is missing ${expected}:\n${grokConfig}`);
}

const plistPath = path.join(home, "Library", "LaunchAgents", "com.mouaadsk.codex-auth-advanced.proxy.plist");
const plist = fs.readFileSync(plistPath, "utf8");
for (const expected of [serviceRunner, "<key>RunAtLoad</key>", "<key>KeepAlive</key>", `<string>${home}</string>`, String(proxyPort)]) {
  if (!plist.includes(expected)) throw new Error(`LaunchAgent is missing ${expected}:\n${plist}`);
}

const codexBackupsAfterFirst = backupCount(codexConfigPath);
const claudeBackupsAfterFirst = backupCount(claudeSettingsPath);
const grokBackupsAfterFirst = backupCount(grokConfigPath);
if (codexBackupsAfterFirst !== 1 || claudeBackupsAfterFirst !== 1 || grokBackupsAfterFirst !== 1) {
  throw new Error(`expected one client backup each, got Codex=${codexBackupsAfterFirst}, Claude=${claudeBackupsAfterFirst}, Grok=${grokBackupsAfterFirst}`);
}

const second = await runInstaller();
if (!second.stdout.includes("Codex: already configured")
  || !second.stdout.includes("Claude Code: already configured")
  || !second.stdout.includes("Grok Build: already configured")) {
  throw new Error(`installer was not idempotent:\n${second.stdout}\n${second.stderr}`);
}
if (!second.stdout.includes("Codex models: already configured")) {
  throw new Error(`installer rewrote an unchanged Codex model catalog:\n${second.stdout}\n${second.stderr}`);
}
if (backupCount(codexConfigPath) !== codexBackupsAfterFirst
  || backupCount(claudeSettingsPath) !== claudeBackupsAfterFirst
  || backupCount(grokConfigPath) !== grokBackupsAfterFirst) {
  throw new Error("idempotent install created unnecessary additional backups");
}

const configureAll = await runWrapper(["configure"]);
if (!configureAll.stdout.includes("Codex: already configured")
  || !configureAll.stdout.includes("Claude Code: already configured")
  || !configureAll.stdout.includes("Grok Build: already configured")) {
  throw new Error(`configure did not default to all clients:\n${configureAll.stdout}\n${configureAll.stderr}`);
}
const configureExplicitAll = await runWrapper(["configure", "all"]);
if (!configureExplicitAll.stdout.includes("Codex: already configured")
  || !configureExplicitAll.stdout.includes("Claude Code: already configured")
  || !configureExplicitAll.stdout.includes("Grok Build: already configured")) {
  throw new Error(`configure all did not configure every client:\n${configureExplicitAll.stdout}\n${configureExplicitAll.stderr}`);
}
const configureCodex = await runWrapper(["configure", "codex"]);
if (!configureCodex.stdout.includes("Codex: already configured")
  || configureCodex.stdout.includes("Claude Code:")
  || configureCodex.stdout.includes("Grok Build:")) {
  throw new Error(`configure codex did not stay scoped to Codex:\n${configureCodex.stdout}`);
}
const configureClaude = await runWrapper(["configure", "claude"]);
if (!configureClaude.stdout.includes("Claude Code: already configured")
  || configureClaude.stdout.includes("Codex:")
  || configureClaude.stdout.includes("Grok Build:")) {
  throw new Error(`configure claude did not stay scoped to Claude Code:\n${configureClaude.stdout}`);
}
const configureGrok = await runWrapper(["configure", "grok"]);
if (!configureGrok.stdout.includes("Grok Build: already configured")
  || configureGrok.stdout.includes("Codex:")
  || configureGrok.stdout.includes("Claude Code:")) {
  throw new Error(`configure grok did not stay scoped to Grok Build:\n${configureGrok.stdout}`);
}
if (backupCount(codexConfigPath) !== codexBackupsAfterFirst
  || backupCount(claudeSettingsPath) !== claudeBackupsAfterFirst
  || backupCount(grokConfigPath) !== grokBackupsAfterFirst) {
  throw new Error("direct configure commands created unnecessary backups");
}

await new Promise((resolve) => gatewayProxy.close(resolve));
console.log("macOS installer configuration ok");
