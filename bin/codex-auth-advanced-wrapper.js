#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  apiKeySessionConfigKeys,
  tomlLiteralForCli,
  tomlStringForCli,
  topLevelTomlValues
} from "../src/codex-config.mjs";
import {
  defaultCodexHome,
  managedGroupCodexHome,
  pathContains,
  projectsConfigPath,
  readJsonFile,
  readTextFile,
  realPathIfPossible,
  rootConfigPath
} from "../src/storage.mjs";
import { createProviderProxy } from "../src/provider-proxy.mjs";
import { createAccountService } from "../src/account-service.mjs";
import { createClientConfigService } from "../src/client-config.mjs";
import { createCliService } from "../src/cli-service.mjs";
import { createManagerService } from "../src/manager-service.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootPackageJsonPath = path.join(__dirname, "..", "package.json");
const requiredNodeMajor = 22;
const invokedCommandName = path.basename(process.argv[1] ?? "codex-auth-advanced", path.extname(process.argv[1] ?? ""));
const launchAgentLabel = "com.mouaadsk.codex-auth-advanced.manager";
const providerProxyHost = process.env.CODEX_AUTH_ADVANCED_PROXY_HOST || "127.0.0.1";
const providerProxyPort = Number(process.env.CODEX_AUTH_ADVANCED_PROXY_PORT || 47778);
const providerProxyPrefix = "/_codex-auth-advanced";
const officialAnthropicBaseUrl = process.env.CODEX_AUTH_ADVANCED_ANTHROPIC_BASE_URL || "https://api.anthropic.com";
const vsllmTransientUsageLimitMaxRetries = 1;
const vsllmTransientUsageLimitRetryDelayMs = 500;
const modelCapacityMaxRetries = 3;
const configuredModelCapacityRetryBaseDelayMs = Number(process.env.CODEX_AUTH_ADVANCED_MODEL_CAPACITY_RETRY_BASE_MS);
const modelCapacityRetryBaseDelayMs = Number.isFinite(configuredModelCapacityRetryBaseDelayMs)
  && configuredModelCapacityRetryBaseDelayMs >= 0
  ? configuredModelCapacityRetryBaseDelayMs
  : 1000;
// Fail fast when a provider accepts an SSE request then goes silent (observed
// with VSLLM gpt-5.6-sol on large contexts: no bytes, no PINGs, client hangs
// until its own 5-minute SSE idle timeout). 90s is comfortably above the
// slowest healthy first-byte times we measured (~30s); 0 disables.
const configuredStreamStallWatchdogMs = Number(process.env.CODEX_AUTH_ADVANCED_STREAM_STALL_WATCHDOG_MS);
const streamStallWatchdogMs = Number.isFinite(configuredStreamStallWatchdogMs)
  && configuredStreamStallWatchdogMs >= 0
  ? configuredStreamStallWatchdogMs
  : 90000;
const chatgptCodexBaseUrl = process.env.CODEX_AUTH_ADVANCED_CHATGPT_BASE_URL || "https://chatgpt.com/backend-api/codex";
let accountService = null;
const providerProxy = createProviderProxy({
  host: providerProxyHost,
  port: providerProxyPort,
  prefix: providerProxyPrefix,
  activeApiProxyTarget: (...args) => accountService.activeApiProxyTarget(...args),
  pinnedApiProxyTarget: (...args) => accountService.pinnedApiProxyTarget(...args),
  markApiAccountExhaustedFromProxy: (...args) => accountService.markApiAccountExhaustedFromProxy(...args),
  switchFromExhaustedApiAccount: (...args) => accountService.switchFromExhaustedApiAccount(...args),
  targetFromTransientApiFailure: (...args) => accountService.targetFromTransientApiFailure(...args),
  vsllmTransientUsageLimitMaxRetries,
  vsllmTransientUsageLimitRetryDelayMs,
  modelCapacityMaxRetries,
  modelCapacityRetryBaseDelayMs,
  streamStallWatchdogMs,
  officialAnthropicBaseUrl
});
accountService = createAccountService({ providerProxy, chatgptCodexBaseUrl });
const {
  snapshotApiAccountMetadata,
  restoreApiAccountMetadataSnapshot
} = accountService;
const clientConfigService = createClientConfigService({
  providerProxy,
  accountService
});
const {
  ensureAllActiveAccountConfigs,
  maybeHandleClientConfigure,
  ensureProviderProxyForActiveApiAccounts
} = clientConfigService;
const managerService = createManagerService({
  launchAgentLabel,
  accountService,
  childEnvForArgv,
  exitFromChild
});
const {
  writeManagerPidFile,
  removeManagerPidFile,
  ensureAutoSwitchManagerRunning,
  stopAutoSwitchManager,
  maybeRunStatus
} = managerService;

function ensureSupportedNodeVersion() {
  const major = Number(process.versions?.node?.split(".")[0] ?? 0);
  if (Number.isInteger(major) && major >= requiredNodeMajor) {
    return;
  }

  console.error(
    `Node.js ${requiredNodeMajor}+ is required to run codex-auth-advanced. Current version: ${process.version}.`
  );
  process.exit(1);
}

ensureSupportedNodeVersion();

function rememberedProjectGroupForCwd(cwd = process.cwd()) {
  const config = readJsonFile(projectsConfigPath());
  if (!config || !Array.isArray(config.projects)) return "default";

  const currentPath = realPathIfPossible(cwd);
  let best = null;
  for (const project of config.projects) {
    if (typeof project?.root !== "string" || typeof project?.group !== "string") continue;
    const rootPath = realPathIfPossible(project.root);
    if (!pathContains(rootPath, currentPath)) continue;
    if (!best || rootPath.length > best.rootPath.length) {
      best = { rootPath, group: project.group };
    }
  }
  return best?.group || "default";
}

function launchCodexHome(argv) {
  if (argv[0] === "launch") {
    return managedGroupCodexHome(rememberedProjectGroupForCwd());
  }
  if (argv[0] === "group" && typeof argv[1] === "string" && argv[2] === "launch") {
    return managedGroupCodexHome(argv[1]);
  }
  return null;
}

function hasArg(args, names) {
  const wanted = new Set(names);
  return args.some((arg) => wanted.has(arg) || [...wanted].some((name) => arg.startsWith(`${name}=`)));
}

function configOverrideValue(arg) {
  const eq = String(arg || "").indexOf("=");
  if (eq <= 0) return null;
  return String(arg).slice(0, eq).trim();
}

function hasConfigOverride(args, key) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    let value = null;
    if (arg === "-c" || arg === "--config") {
      value = args[i + 1];
      i += 1;
    } else if (arg.startsWith("--config=")) {
      value = arg.slice("--config=".length);
    }
    if (configOverrideValue(value) === key) return true;
  }
  return false;
}

const codexSubcommands = new Set(["resume", "fork", "exec", "review", "apply"]);

function launchPassthroughArgs(argv) {
  const separatorIndex = argv.indexOf("--");
  if (separatorIndex !== -1) {
    return {
      head: argv.slice(0, separatorIndex),
      passthrough: argv.slice(separatorIndex + 1)
    };
  }
  const subIndex = argv.findIndex((arg) => codexSubcommands.has(arg));
  if (subIndex !== -1) {
    return {
      head: argv.slice(0, subIndex),
      passthrough: argv.slice(subIndex)
    };
  }
  return { head: argv, passthrough: [] };
}

function isHelpOrVersionArgs(args) {
  return hasArg(args, ["--help", "-h", "--version", "-V"]);
}

function launchConfigOverrideArgs(codexHome, passthrough) {
  const values = topLevelTomlValues(readTextFile(rootConfigPath(codexHome)), apiKeySessionConfigKeys);
  const overrides = [];
  const model = tomlStringForCli(values.get("model"));
  if (model && !hasArg(passthrough, ["--model", "-m"]) && !hasConfigOverride(passthrough, "model")) {
    overrides.push("--model", model);
  }
  const reasoningEffort = tomlLiteralForCli(values.get("model_reasoning_effort"));
  if (reasoningEffort && !hasConfigOverride(passthrough, "model_reasoning_effort")) {
    overrides.push("-c", `model_reasoning_effort=${reasoningEffort}`);
  }
  return overrides;
}

function launchArgvWithCurrentConfig(argv) {
  const codexHome = launchCodexHome(argv);
  if (!codexHome) return argv;
  if (isHelpOrVersionArgs(argv)) return argv;

  const { head, passthrough } = launchPassthroughArgs(argv);
  if (isHelpOrVersionArgs(passthrough)) return argv;

  const overrides = launchConfigOverrideArgs(codexHome, passthrough);
  if (overrides.length === 0) return argv;
  return [...head, "--", ...overrides, ...passthrough];
}

function readRootPackage() {
  try {
    return JSON.parse(fs.readFileSync(rootPackageJsonPath, "utf8"));
  } catch {
    return null;
  }
}

function maybePrintPreviewVersion(argv) {
  if (argv.length !== 1) return false;
  if (argv[0] !== "--version" && argv[0] !== "-V") return false;

  const rootPackage = readRootPackage();
  if (!rootPackage) return false;

  const previewLabel = rootPackage.codexAuthAdvancedPreviewLabel;
  if (typeof previewLabel !== "string" || previewLabel.length === 0) return false;
  if (typeof rootPackage.version !== "string" || rootPackage.version.length === 0) return false;

  process.stdout.write(`${invokedCommandName} ${rootPackage.version} (preview ${previewLabel})\n`);
  return true;
}

function patchTopLevelHelp(output) {
  const command = "  configure [all|codex|claude]                                                  Configure Codex and/or Claude Code to use the local proxy";
  if (output.includes(command)) return output;
  const notes = "\nNotes:\n";
  if (output.includes(notes)) return output.replace(notes, `${command}\n${notes}`);
  return `${output.trimEnd()}\n${command}\n`;
}

function maybeRunTopLevelHelp(binaryPath, argv) {
  if (argv.length !== 1 || !["--help", "-h"].includes(argv[0])) return false;
  const child = spawnSync(binaryPath, argv, {
    stdio: ["inherit", "pipe", "pipe"],
    encoding: "utf8",
    env: childEnvForArgv(argv)
  });
  const helpOutput = child.stdout ? patchTopLevelHelp(child.stdout) : "";
  if (helpOutput) process.stdout.write(helpOutput);
  if (helpOutput.includes("\nCommands:\n") || helpOutput.includes("Usage:")) return true;
  if (child.stderr) process.stderr.write(child.stderr);
  exitFromChild(child);
  return true;
}

if (maybePrintPreviewVersion(process.argv.slice(2))) {
  process.exit(0);
}

function childEnvForArgv(argv) {
  const env = {
    ...process.env,
    CODEX_AUTH_ADVANCED_NODE_EXECUTABLE: process.execPath
  };
  if (argv[0] === "group" && argv[1] === "default") {
    env.CODEX_HOME = defaultCodexHome();
  }
  return env;
}

function isAutoConfigCommand(argv) {
  if (argv[0] === "config" && argv[1] === "auto") return true;
  return argv[0] === "group" && typeof argv[1] === "string" && argv[2] === "auto";
}

function autoConfigAction(argv) {
  if (argv[0] === "config" && argv[1] === "auto") return argv[2] || "";
  if (argv[0] === "group" && typeof argv[1] === "string" && argv[2] === "auto") return argv[3] || "";
  return "";
}

function resolveBinary() {
  const platformDir = `${process.platform}-${process.arch}`;
  const vendorBinDir = path.join(__dirname, "..", "vendor", platformDir, "bin");
  if (!fs.existsSync(vendorBinDir)) {
    console.error(`Unsupported platform: ${process.platform}/${process.arch}`);
    console.error(`Missing local binary directory: ${vendorBinDir}`);
    process.exit(1);
  }

  const advancedBinaryName = process.platform === "win32" ? "codex-auth-advanced.exe" : "codex-auth-advanced";
  const binaryPath = path.join(vendorBinDir, advancedBinaryName);
  if (!fs.existsSync(binaryPath)) {
    console.error(`Missing local binary: ${binaryPath}`);
    process.exit(1);
  }
  return binaryPath;
}

const cliService = createCliService({
  providerProxy,
  accountService,
  clientConfigService,
  writeManagerPidFile,
  removeManagerPidFile,
  ensureAutoSwitchManagerRunning,
  stopAutoSwitchManager,
  childEnvForArgv,
  exitFromChild
});
const {
  maybeHandleProviderProxy,
  parseApiSpendLimitArgs,
  importCommandInfo,
  applyApiSpendLimitToImportedAccounts,
  maybeHandleStoredListLive,
  maybeHandleStoredSwitch,
  sleep,
  maybeHandleAutoConfig,
  maybeHandleDaemon,
  maybeHandleApiSpendLimitConfig,
  maybeHandleVsllmDashboardConfig,
  maybeHandleAddApiKey,
  syncApiKeySpendLimits,
  syncMissingApiKeyConfigsAllGroups,
  maybeRunApiKeyAwareGroupList
} = cliService;

const binaryPath = resolveBinary();
const parsedApiSpendLimitArgs = parseApiSpendLimitArgs(process.argv.slice(2));
const argv = launchArgvWithCurrentConfig(parsedApiSpendLimitArgs.argv);
if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-V")) {
  const child = spawnSync(binaryPath, argv, {
    stdio: "inherit",
    env: childEnvForArgv(argv)
  });
  exitFromChild(child);
}
if (maybeRunTopLevelHelp(binaryPath, argv)) {
  process.exit(0);
}
const apiSpendLimitImportInfo = importCommandInfo(argv);

if (parsedApiSpendLimitArgs.found && !apiSpendLimitImportInfo) {
  console.error("--api-spend-limit-usd can only be used with `import` or `group <name> import`.");
  process.exit(1);
}

if (await maybeHandleProviderProxy(argv)) {
  process.exit(0);
}

if (await maybeHandleClientConfigure(argv)) {
  process.exit(0);
}

if (await maybeHandleApiSpendLimitConfig(argv)) {
  process.exit(0);
}

if (await maybeHandleVsllmDashboardConfig(argv)) {
  process.exit(0);
}

if (await maybeHandleAddApiKey(argv)) {
  process.exit(0);
}

if (await maybeHandleAutoConfig(argv)) {
  process.exit(0);
}

if (await maybeHandleDaemon(argv)) {
  process.exit(0);
}

syncMissingApiKeyConfigsAllGroups();

if (!apiSpendLimitImportInfo) {
  await syncApiKeySpendLimits();
}

if (await maybeHandleStoredListLive(argv)) {
  process.exit(0);
}

if (await maybeHandleStoredSwitch(argv)) {
  process.exit(0);
}

ensureAllActiveAccountConfigs();

if (maybeRunStatus(binaryPath, argv)) {
  process.exit(0);
}

function exitFromChild(child) {
  if (child.error) {
    console.error(child.error.message);
    process.exit(1);
  }

  if (child.signal) {
    process.kill(process.pid, child.signal);
  } else {
    process.exit(child.status ?? 1);
  }
}

if (!(await maybeRunApiKeyAwareGroupList(binaryPath, argv))) {
  if (argv.includes("launch")) {
    await ensureProviderProxyForActiveApiAccounts();
  }
  const apiAccountMetadataBeforeChild = snapshotApiAccountMetadata();
  const child = spawnSync(binaryPath, argv, {
    stdio: "inherit",
    env: childEnvForArgv(argv)
  });

  if (!child.error && !child.signal && (child.status ?? 1) === 0) {
    restoreApiAccountMetadataSnapshot(apiAccountMetadataBeforeChild);
    if (apiSpendLimitImportInfo) {
      applyApiSpendLimitToImportedAccounts(apiSpendLimitImportInfo.codexHome, apiSpendLimitImportInfo.args, parsedApiSpendLimitArgs.limitUsd);
    }
    await syncApiKeySpendLimits();
    syncMissingApiKeyConfigsAllGroups();
    if (isAutoConfigCommand(argv)) {
      if (autoConfigAction(argv) === "disable") {
        stopAutoSwitchManager();
      } else {
        ensureAutoSwitchManagerRunning();
      }
    }
    ensureAllActiveAccountConfigs();
  }

  exitFromChild(child);
}
