import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultCodexHome,
  ensureDir,
  managedGroupCodexHome,
  managerPidPath,
  readJsonFile,
  readTextFile,
  registryPath,
  userHome,
  writeTextFilePrivate
} from "./storage.mjs";

const wrapperScriptPath = fileURLToPath(new URL("../bin/codex-auth-advanced.js", import.meta.url));

export function createManagerService({
  launchAgentLabel,
  accountService,
  childEnvForArgv,
  exitFromChild
}) {
  const {
    accountLabel,
    accountPlanLabel,
    activeRegistryAccountFromRegistry
  } = accountService;

  function sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  function writeManagerPidFile() {
    ensureDir(path.dirname(managerPidPath()));
    writeTextFilePrivate(managerPidPath(), `${process.pid}\n`, 0o600);
  }

  function removeManagerPidFile() {
    try {
      const existing = readTextFile(managerPidPath()).trim();
      if (!existing || Number(existing) === process.pid) fs.rmSync(managerPidPath(), { force: true });
    } catch {
      // Best effort cleanup only.
    }
  }

  function processIsRunning(pid) {
    const numericPid = Number(pid);
    if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
    try {
      process.kill(numericPid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function fallbackManagerIsRunning() {
    return processIsRunning(readTextFile(managerPidPath()).trim());
  }

  function stopFallbackManager() {
    const pid = Number(readTextFile(managerPidPath()).trim());
    if (processIsRunning(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Best effort; a stale pid file is removed below.
      }
    }
    try {
      fs.rmSync(managerPidPath(), { force: true });
    } catch {
      // Best effort cleanup only.
    }
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
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin"
    ])].join(":");
  }

  function repairMacLaunchAgentPath() {
    if (process.platform !== "darwin") return;
    const launchAgentsDir = path.join(userHome(), "Library", "LaunchAgents");
    const plistPath = path.join(launchAgentsDir, `${launchAgentLabel}.plist`);
    const scriptPath = wrapperScriptPath;
    const plist = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key>',
      `  <string>${launchAgentLabel}</string>`,
      '  <key>ProgramArguments</key>',
      '  <array>',
      `    <string>${xmlEscape(process.execPath)}</string>`,
      `    <string>${xmlEscape(scriptPath)}</string>`,
      '    <string>daemon</string>',
      '    <string>--manager</string>',
      '  </array>',
      '  <key>EnvironmentVariables</key>',
      '  <dict>',
      '    <key>CODEX_AUTH_ADVANCED_VERSION</key>',
      '    <string>0.3.0-alpha.2</string>',
      '    <key>CODEX_AUTH_ADVANCED_NODE_EXECUTABLE</key>',
      `    <string>${xmlEscape(process.execPath)}</string>`,
      '    <key>HOME</key>',
      `    <string>${xmlEscape(userHome())}</string>`,
      '    <key>PATH</key>',
      `    <string>${xmlEscape(launchAgentPathEnv())}</string>`,
      '  </dict>',
      '  <key>RunAtLoad</key>',
      '  <true/>',
      '  <key>KeepAlive</key>',
      '  <true/>',
      '</dict>',
      '</plist>',
      ''
    ].join("\n");
    ensureDir(launchAgentsDir);
    fs.writeFileSync(plistPath, plist, "utf8");
    for (const fileName of fs.readdirSync(launchAgentsDir)) {
      if (fileName === path.basename(plistPath)) continue;
      if (!fileName.endsWith(".codex-auth-advanced.manager.plist")) continue;
      fs.rmSync(path.join(launchAgentsDir, fileName));
    }
    unloadStaleMacLaunchAgents(launchAgentsDir, plistPath);
  }

  function macLaunchAgentDomain() {
    if (process.platform !== "darwin") return null;
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    return uid == null ? null : `gui/${uid}`;
  }

  function macLaunchAgentPlistPath() {
    return path.join(userHome(), "Library", "LaunchAgents", `${launchAgentLabel}.plist`);
  }

  function bootoutMacLaunchAgent() {
    const domain = macLaunchAgentDomain();
    if (!domain) return;
    spawnSync("launchctl", ["bootout", `${domain}/${launchAgentLabel}`], {
      stdio: "ignore"
    });
  }

  function bootstrapMacLaunchAgent() {
    const domain = macLaunchAgentDomain();
    if (!domain) return;
    const plistPath = macLaunchAgentPlistPath();
    if (!fs.existsSync(plistPath)) return;
    bootoutMacLaunchAgent();
    spawnSync("launchctl", ["bootstrap", domain, plistPath], {
      stdio: "ignore"
    });
    spawnSync("launchctl", ["kickstart", "-k", `${domain}/${launchAgentLabel}`], {
      stdio: "ignore"
    });
  }

  function startDetachedManagerFallback() {
    if (fallbackManagerIsRunning()) return;
    const scriptPath = wrapperScriptPath;
    const child = spawn(process.execPath, [scriptPath, "daemon", "--manager"], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        CODEX_AUTH_ADVANCED_NODE_EXECUTABLE: process.execPath,
        HOME: userHome()
      }
    });
    child.unref();
    ensureDir(path.dirname(managerPidPath()));
    writeTextFilePrivate(managerPidPath(), `${child.pid}\n`, 0o600);
  }

  function ensureAutoSwitchManagerRunning() {
    stopFallbackManager();
    repairMacLaunchAgentPath();
    bootstrapMacLaunchAgent();
    for (let i = 0; i < 20; i += 1) {
      if (macLaunchAgentIsRunning()) return;
      sleep(100);
    }
    if (!macLaunchAgentIsRunning()) {
      startDetachedManagerFallback();
    }
  }

  function stopAutoSwitchManager() {
    bootoutMacLaunchAgent();
    stopFallbackManager();
  }

  function unloadStaleMacLaunchAgents(launchAgentsDir, currentPlistPath) {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid == null) return;

    const labels = new Set();
    try {
      for (const fileName of fs.readdirSync(launchAgentsDir)) {
        if (fileName === path.basename(currentPlistPath)) continue;
        if (!fileName.endsWith(".codex-auth-advanced.manager.plist")) continue;
        labels.add(fileName.slice(0, -".plist".length));
      }
    } catch {
      return;
    }

    const domain = `gui/${uid}`;
    const child = spawnSync("launchctl", ["print", domain], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8"
    });
    if ((child.status ?? 1) === 0) {
      const labelPattern = /^\s*(?:\d+\s+\S+\s+)?([A-Za-z0-9_.-]+\.codex-auth-advanced\.manager)(?:\s*=)?\s*$/gm;
      let match = labelPattern.exec(child.stdout);
      while (match) {
        if (match[1] !== launchAgentLabel) labels.add(match[1]);
        match = labelPattern.exec(child.stdout);
      }
    }

    for (const label of labels) {
      if (label === launchAgentLabel) continue;
      spawnSync("launchctl", ["bootout", `${domain}/${label}`], {
        stdio: "ignore"
      });
    }
  }

  function isStatusCommand(argv) {
    if (argv[0] === "status") return true;
    if (argv[0] === "group" && argv[1] === "status") return true;
    return argv[0] === "group" && typeof argv[1] === "string" && argv[2] === "status";
  }

  function statusCodexHome(argv) {
    if (argv[0] === "status") return defaultCodexHome();
    if (argv[0] === "group" && argv[1] === "status" && typeof argv[2] === "string") {
      return managedGroupCodexHome(argv[2]);
    }
    if (argv[0] === "group" && typeof argv[1] === "string" && argv[2] === "status") {
      return managedGroupCodexHome(argv[1]);
    }
    return null;
  }

  function macLaunchAgentIsRunning() {
    const domain = macLaunchAgentDomain();
    if (!domain) return null;
    const child = spawnSync("launchctl", ["print", `${domain}/${launchAgentLabel}`], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8"
    });
    if ((child.status ?? 1) !== 0) return false;
    return child.stdout.includes("state = running");
  }

  function autoSwitchServiceIsRunning() {
    const launchAgentRunning = macLaunchAgentIsRunning();
    if (launchAgentRunning == null) return fallbackManagerIsRunning() ? true : null;
    return launchAgentRunning || fallbackManagerIsRunning();
  }

  function activeAccountStatusLine(codexHome) {
    if (!codexHome) return null;
    const registry = readJsonFile(registryPath(codexHome));
    const active = activeRegistryAccountFromRegistry(registry);
    if (!active) return null;
    const plan = accountPlanLabel(active);
    return `account: ${accountLabel(active)}${plan && plan !== "-" ? ` (${plan})` : ""}`;
  }

  function patchStatusOutput(output, argv) {
    const serviceRunning = autoSwitchServiceIsRunning();
    let patched = output;
    const accountLine = activeAccountStatusLine(statusCodexHome(argv));
    if (accountLine) {
      if (/^account: .*$/m.test(patched)) {
        patched = patched.replace(/^account: .*$/m, accountLine);
      } else {
        patched = `${patched.trimEnd()}\n${accountLine}\n`;
      }
    }
    if (serviceRunning == null) return patched;
    const serviceLine = `service: ${serviceRunning ? "running" : "stopped"}`;
    if (/^service: .*$/m.test(patched)) {
      return patched.replace(/^service: .*$/m, serviceLine);
    }
    return `${patched.trimEnd()}\n${serviceLine}\n`;
  }

  function maybeRunStatus(binaryPath, argv) {
    if (!isStatusCommand(argv)) return false;
    const child = spawnSync(binaryPath, argv, {
      stdio: ["inherit", "pipe", "pipe"],
      encoding: "utf8",
      env: childEnvForArgv(argv)
    });
    if (child.stdout) process.stdout.write(patchStatusOutput(child.stdout, argv));
    if (child.stderr) process.stderr.write(child.stderr);
    exitFromChild(child);
    return true;
  }

  return {
    writeManagerPidFile,
    removeManagerPidFile,
    fallbackManagerIsRunning,
    stopFallbackManager,
    ensureAutoSwitchManagerRunning,
    stopAutoSwitchManager,
    maybeRunStatus
  };
}

