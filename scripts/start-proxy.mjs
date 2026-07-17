#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  kickstartProxyLaunchAgent,
  proxyLaunchAgentIsLoaded,
  proxyRuntime
} from "./proxy-runtime.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const wrapper = path.join(repoRoot, "bin", "codex-auth-advanced.js");
const logDir = path.join(repoRoot, "scratch");
const logFile = path.join(logDir, "proxy.log");
const runtime = proxyRuntime();
const healthUrl = runtime.healthUrl;
let lastHealthError = "";

async function proxyIsRunning() {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
    lastHealthError = `HTTP ${response.status}`;
    return response.status === 200;
  } catch (error) {
    const cause = error?.cause ? `; cause: ${error.cause?.code || error.cause?.name || "Error"}: ${error.cause?.message || error.cause}` : "";
    lastHealthError = `${error?.name || "Error"}: ${error?.message || error}${cause}`;
    return false;
  }
}

async function waitForProxy(attempts, delayMs) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await proxyIsRunning()) return true;
    await sleep(delayMs);
  }
  return false;
}

if (!fs.existsSync(wrapper)) {
  console.error(`Missing wrapper: ${wrapper}`);
  process.exit(1);
}

if (await waitForProxy(10, 200)) {
  console.log(`provider proxy: running (${healthUrl})`);
  process.exit(0);
}

if (proxyLaunchAgentIsLoaded()) {
  kickstartProxyLaunchAgent();
  if (await waitForProxy(200, 100)) {
    console.log(`provider proxy: running (${healthUrl}, managed by launchd)`);
    process.exit(0);
  }
  const managedLog = path.join(process.env.HOME || "~", "Library", "Logs", "codex-auth-advanced", "proxy.error.log");
  console.error(`launchd provider proxy did not start; last health check: ${lastHealthError}; see ${managedLog}`);
  process.exit(1);
}

fs.mkdirSync(logDir, { recursive: true });
const outFd = fs.openSync(logFile, "a");
const child = spawn(process.execPath, [wrapper, "proxy", "serve"], {
  detached: true,
  stdio: ["ignore", outFd, outFd],
  env: {
    ...process.env,
    CODEX_AUTH_ADVANCED_NODE_EXECUTABLE: process.execPath,
    CODEX_AUTH_ADVANCED_PROVIDER_PROXY_CHILD: "1"
  }
});
child.unref();

if (await waitForProxy(200, 100)) {
  console.log(`provider proxy: running (${healthUrl})`);
  process.exit(0);
}

console.error(`provider proxy did not start; last health check: ${lastHealthError}; see ${logFile}`);
process.exit(1);
