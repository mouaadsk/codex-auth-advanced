import { spawn } from "node:child_process";
import fs from "node:fs";
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
const fakeBin = path.join(tempRoot, "bin");
const proxyPort = 47891;

for (const directory of [accountsDir, claudeDir, fakeBin]) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}
for (const command of ["codex", "claude"]) {
  const executable = path.join(fakeBin, command);
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.chmodSync(executable, 0o755);
}

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
const configureHelp = await runWrapper(["configure", "--help"]);
for (const expected of [
  "Usage: codex-auth-advanced configure [all|codex|claude]",
  "all      Configure Codex and Claude Code (default).",
  "codex    Configure Codex",
  "claude   Configure Claude Code"
]) {
  if (!configureHelp.stdout.includes(expected)) {
    throw new Error(`configure help is missing ${expected}:\n${configureHelp.stdout}`);
  }
}
const topLevelHelp = await runWrapper(["--help"]);
if (!topLevelHelp.stdout.includes("configure [all|codex|claude]")) {
  throw new Error(`top-level help does not advertise configure:\n${topLevelHelp.stdout}`);
}

const first = await runInstaller();
if (!first.stdout.includes("Codex: configured") || !first.stdout.includes("Claude Code: configured")) {
  throw new Error(`installer did not configure both clients:\n${first.stdout}\n${first.stderr}`);
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
  "[features]",
  "multi_agent = true"
]) {
  if (!codexConfig.includes(expected)) throw new Error(`Codex config lost ${expected}:\n${codexConfig}`);
}
if (codexConfig.includes("[model_providers.OpenAI]") || codexConfig.includes("old-gateway.example")) {
  throw new Error(`Codex config retained the obsolete provider block:\n${codexConfig}`);
}

const claudeSettingsPath = path.join(claudeDir, "settings.json");
const claudeSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, "utf8"));
if (claudeSettings.effortLevel !== "high" || claudeSettings.enabledPlugins?.example !== true) {
  throw new Error(`Claude settings lost unrelated values: ${JSON.stringify(claudeSettings)}`);
}
if (claudeSettings.env.ANTHROPIC_BASE_URL !== expectedBaseUrl
  || claudeSettings.env.ANTHROPIC_AUTH_TOKEN !== "codex-auth-advanced-local-proxy"
  || claudeSettings.env.ANTHROPIC_DEFAULT_FABLE_MODEL !== "claude-fable-5"
  || claudeSettings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY !== "1") {
  throw new Error(`Claude proxy settings are incomplete: ${JSON.stringify(claudeSettings.env)}`);
}
if (claudeSettings.env.ANTHROPIC_API_KEY != null) {
  throw new Error("Claude settings retained a conflicting ANTHROPIC_API_KEY");
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

const plistPath = path.join(home, "Library", "LaunchAgents", "com.mouaadsk.codex-auth-advanced.proxy.plist");
const plist = fs.readFileSync(plistPath, "utf8");
for (const expected of [serviceRunner, "<key>RunAtLoad</key>", "<key>KeepAlive</key>", `<string>${home}</string>`, String(proxyPort)]) {
  if (!plist.includes(expected)) throw new Error(`LaunchAgent is missing ${expected}:\n${plist}`);
}

const codexBackupsAfterFirst = backupCount(codexConfigPath);
const claudeBackupsAfterFirst = backupCount(claudeSettingsPath);
if (codexBackupsAfterFirst !== 1 || claudeBackupsAfterFirst !== 1) {
  throw new Error(`expected one client backup each, got Codex=${codexBackupsAfterFirst}, Claude=${claudeBackupsAfterFirst}`);
}

const second = await runInstaller();
if (!second.stdout.includes("Codex: already configured") || !second.stdout.includes("Claude Code: already configured")) {
  throw new Error(`installer was not idempotent:\n${second.stdout}\n${second.stderr}`);
}
if (backupCount(codexConfigPath) !== codexBackupsAfterFirst || backupCount(claudeSettingsPath) !== claudeBackupsAfterFirst) {
  throw new Error("idempotent install created unnecessary additional backups");
}

const configureAll = await runWrapper(["configure"]);
if (!configureAll.stdout.includes("Codex: already configured")
  || !configureAll.stdout.includes("Claude Code: already configured")) {
  throw new Error(`configure did not default to all clients:\n${configureAll.stdout}\n${configureAll.stderr}`);
}
const configureExplicitAll = await runWrapper(["configure", "all"]);
if (!configureExplicitAll.stdout.includes("Codex: already configured")
  || !configureExplicitAll.stdout.includes("Claude Code: already configured")) {
  throw new Error(`configure all did not configure both clients:\n${configureExplicitAll.stdout}\n${configureExplicitAll.stderr}`);
}
const configureCodex = await runWrapper(["configure", "codex"]);
if (!configureCodex.stdout.includes("Codex: already configured") || configureCodex.stdout.includes("Claude Code:")) {
  throw new Error(`configure codex did not stay scoped to Codex:\n${configureCodex.stdout}`);
}
const configureClaude = await runWrapper(["configure", "claude"]);
if (!configureClaude.stdout.includes("Claude Code: already configured") || configureClaude.stdout.includes("Codex:")) {
  throw new Error(`configure claude did not stay scoped to Claude Code:\n${configureClaude.stdout}`);
}
if (backupCount(codexConfigPath) !== codexBackupsAfterFirst || backupCount(claudeSettingsPath) !== claudeBackupsAfterFirst) {
  throw new Error("direct configure commands created unnecessary backups");
}

console.log("macOS installer configuration ok");
