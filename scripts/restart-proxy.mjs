#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const startScript = path.join(scriptDir, "start-proxy.mjs");
const proxyHost = process.env.CODEX_AUTH_ADVANCED_PROXY_HOST || "127.0.0.1";
const proxyPort = Number(process.env.CODEX_AUTH_ADVANCED_PROXY_PORT || 47778);
const proxyPrefix = "/_codex-auth-advanced";
const formattedProxyHost = proxyHost.includes(":") && !proxyHost.startsWith("[") ? `[${proxyHost}]` : proxyHost;
const proxyBaseUrl = `http://${formattedProxyHost}:${proxyPort}${proxyPrefix}`;
const healthUrl = `${proxyBaseUrl}/health`;
const restartUrl = `${proxyBaseUrl}/restart`;

if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
  console.error(`Invalid CODEX_AUTH_ADVANCED_PROXY_PORT: ${process.env.CODEX_AUTH_ADVANCED_PROXY_PORT}`);
  process.exit(1);
}

async function readHealth() {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
    if (response.status !== 200) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function waitForProxyStop() {
  while (await readHealth()) {
    await sleep(150);
  }
}

function runStartScript() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [startScript], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if ((code ?? 1) !== 0 || signal) {
        reject(new Error(`start-proxy failed with ${signal || code}`));
        return;
      }
      resolve();
    });
  });
}

async function requestGracefulRestart() {
  let response;
  try {
    response = await fetch(restartUrl, {
      method: "POST",
      signal: AbortSignal.timeout(3000)
    });
  } catch (error) {
    throw new Error(`could not contact the provider proxy restart endpoint: ${error?.message || error}`);
  }

  if (response.status === 404) {
    throw new Error(
      "the running proxy predates graceful restart support and was left running to protect active streams; wait until the current Codex session is idle before replacing that legacy process"
    );
  }
  if (response.status !== 202) {
    throw new Error(`provider proxy rejected graceful restart with HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

if (!fs.existsSync(startScript)) {
  console.error(`Missing start script: ${startScript}`);
  process.exit(1);
}

const healthBeforeRestart = await readHealth();
if (!healthBeforeRestart) {
  await runStartScript();
  console.log(`provider proxy: started (${healthUrl})`);
  process.exit(0);
}

const restart = await requestGracefulRestart();
console.log(`provider proxy: draining ${restart.active_requests ?? 0} active request(s) and ${restart.active_upgrades ?? 0} active upgrade(s)`);
await waitForProxyStop();
await runStartScript();

const healthAfterRestart = await readHealth();
if (!healthAfterRestart) {
  throw new Error(`provider proxy did not become healthy after restart (${healthUrl})`);
}
console.log(`provider proxy: restarted (${healthUrl})`);
