#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  macLaunchAgentDomain,
  proxyLaunchAgentIsLoaded,
  proxyLaunchAgentLabel,
  proxyRuntime
} from "./proxy-runtime.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const wrapper = path.join(repoRoot, "bin", "codex-auth-advanced.js");
const startScript = path.join(scriptDir, "start-proxy.mjs");
const serviceRunner = path.join(scriptDir, "run-proxy-service.mjs");
const runtime = proxyRuntime();

function usage() {
  process.stdout.write([
    "Usage: ./scripts/install.zsh [--dry-run] [--skip-link] [--skip-service-load]",
    "",
    "Installs the local CLI link, configures installed Codex and Claude Code clients,",
    "and registers a per-user macOS LaunchAgent for the provider proxy.",
    ""
  ].join("\n"));
}

function parseArgs(argv) {
  const options = { dryRun: false, skipLink: false, skipServiceLoad: false };
  for (const arg of argv) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--skip-link") options.skipLink = true;
    else if (arg === "--skip-service-load") options.skipServiceLoad = true;
    else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown install option: ${arg}`);
    }
  }
  return options;
}

function findExecutable(command, env = process.env) {
  const pathValue = String(env.PATH || "");
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return null;
}

function runCommand(command, args, options = {}) {
  const child = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  if (child.error) throw child.error;
  if (child.signal || (child.status ?? 1) !== 0) {
    const details = options.capture ? `\n${child.stdout || ""}${child.stderr || ""}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with ${child.signal || child.status}.${details}`);
  }
  return child;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function launchAgentPathEnv() {
  return [...new Set([
    path.dirname(process.execPath),
    ...String(process.env.PATH || "").split(path.delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ].filter(Boolean))].join(":");
}

function proxyLaunchAgentPlist(home) {
  const launchAgentsDir = path.join(home, "Library", "LaunchAgents");
  const logsDir = path.join(home, "Library", "Logs", "codex-auth-advanced");
  const plistPath = path.join(launchAgentsDir, `${proxyLaunchAgentLabel}.plist`);
  const environment = {
    HOME: home,
    PATH: launchAgentPathEnv(),
    CODEX_AUTH_ADVANCED_NODE_EXECUTABLE: process.execPath,
    CODEX_AUTH_ADVANCED_PROXY_HOST: runtime.host,
    CODEX_AUTH_ADVANCED_PROXY_PORT: String(runtime.port)
  };
  if (process.env.CODEX_HOME) environment.CODEX_HOME = process.env.CODEX_HOME;

  const environmentXml = Object.entries(environment).flatMap(([key, value]) => [
    `    <key>${xmlEscape(key)}</key>`,
    `    <string>${xmlEscape(value)}</string>`
  ]);
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${proxyLaunchAgentLabel}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xmlEscape(process.execPath)}</string>`,
    `    <string>${xmlEscape(serviceRunner)}</string>`,
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${xmlEscape(repoRoot)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...environmentXml,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>ThrottleInterval</key>',
    '  <integer>5</integer>',
    '  <key>StandardOutPath</key>',
    `  <string>${xmlEscape(path.join(logsDir, "proxy.log"))}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xmlEscape(path.join(logsDir, "proxy.error.log"))}</string>`,
    '</dict>',
    '</plist>',
    ''
  ].join("\n");
  return { launchAgentsDir, logsDir, plistPath, plist };
}

function writeLaunchAgent(home, dryRun) {
  const launchAgent = proxyLaunchAgentPlist(home);
  if (dryRun) {
    process.stdout.write(`Would write ${launchAgent.plistPath}.\n`);
    return launchAgent;
  }
  fs.mkdirSync(launchAgent.launchAgentsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(launchAgent.logsDir, { recursive: true, mode: 0o700 });
  const current = fs.existsSync(launchAgent.plistPath) ? fs.readFileSync(launchAgent.plistPath, "utf8") : "";
  if (current !== launchAgent.plist) {
    const tempPath = `${launchAgent.plistPath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, launchAgent.plist, { encoding: "utf8", mode: 0o644 });
    fs.renameSync(tempPath, launchAgent.plistPath);
    process.stdout.write(`Installed LaunchAgent ${launchAgent.plistPath}.\n`);
  } else {
    process.stdout.write(`LaunchAgent already current at ${launchAgent.plistPath}.\n`);
  }
  return launchAgent;
}

function configureClient(name, home, options) {
  const executable = findExecutable(name);
  if (!executable) {
    process.stdout.write(`${name === "claude" ? "Claude Code" : "Codex"}: not installed; skipped.\n`);
    return;
  }
  if (options.dryRun) {
    process.stdout.write(`Would configure ${name === "claude" ? "Claude Code" : "Codex"} using ${executable}.\n`);
    return;
  }
  runCommand(process.execPath, [wrapper, "configure", name === "claude" ? "claude" : "codex"], {
    env: { ...process.env, HOME: home }
  });
}

function loadLaunchAgent(launchAgent, options) {
  if (options.skipServiceLoad) {
    process.stdout.write("LaunchAgent load skipped by --skip-service-load.\n");
    return;
  }
  if (options.dryRun) {
    process.stdout.write(`Would load ${proxyLaunchAgentLabel} and verify ${runtime.healthUrl}.\n`);
    return;
  }
  const domain = macLaunchAgentDomain();
  if (!domain) throw new Error("Could not determine the current macOS launchd user domain.");
  if (!proxyLaunchAgentIsLoaded()) {
    runCommand("launchctl", ["bootstrap", domain, launchAgent.plistPath]);
    process.stdout.write(`Loaded ${proxyLaunchAgentLabel}.\n`);
  } else {
    process.stdout.write(`${proxyLaunchAgentLabel} is already loaded.\n`);
  }
  runCommand("launchctl", ["kickstart", `${domain}/${proxyLaunchAgentLabel}`]);
  runCommand(process.execPath, [startScript]);
}

const options = parseArgs(process.argv.slice(2));
if (process.platform !== "darwin") {
  throw new Error("The installer currently supports macOS only. Windows support is postponed.");
}
const home = process.env.HOME || process.env.USERPROFILE;
if (!home) throw new Error("HOME is required for installation.");
for (const requiredPath of [wrapper, startScript, serviceRunner]) {
  if (!fs.existsSync(requiredPath)) throw new Error(`Missing required install file: ${requiredPath}`);
}

if (!options.skipLink) {
  const npm = findExecutable("npm");
  if (!npm) throw new Error("npm is required to link codex-auth-advanced.");
  if (options.dryRun) process.stdout.write(`Would run ${npm} link in ${repoRoot}.\n`);
  else runCommand(npm, ["link"]);
}

configureClient("codex", home, options);
configureClient("claude", home, options);
const launchAgent = writeLaunchAgent(home, options.dryRun);
loadLaunchAgent(launchAgent, options);
process.stdout.write(`macOS installation ${options.dryRun ? "plan complete" : "complete"}.\n`);
