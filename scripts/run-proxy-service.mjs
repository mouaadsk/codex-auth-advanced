#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { proxyRuntime, readProxyHealth } from "./proxy-runtime.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const wrapper = path.join(repoRoot, "bin", "codex-auth-advanced.js");
const runtime = proxyRuntime();
let stopping = false;
let child = null;
let childExit = null;
let takeoverRequested = false;

if (!fs.existsSync(wrapper)) {
  console.error(`Missing wrapper: ${wrapper}`);
  process.exit(1);
}

async function requestOwnedProxyStop() {
  if (!child) return;
  try {
    const response = await fetch(runtime.restartUrl, {
      method: "POST",
      signal: AbortSignal.timeout(3000)
    });
    if (response.status !== 202 && response.status !== 503) {
      console.error(`Provider proxy service could not request a graceful stop: HTTP ${response.status}`);
    }
  } catch (error) {
    console.error(`Provider proxy service could not request a graceful stop: ${error?.message || error}`);
  }
}

async function requestExternalProxyTakeover() {
  try {
    const response = await fetch(runtime.restartUrl, {
      method: "POST",
      signal: AbortSignal.timeout(3000)
    });
    if (response.status === 202 || response.status === 503) {
      takeoverRequested = true;
      return;
    }
    if (response.status === 404) {
      takeoverRequested = true;
      console.error("Provider proxy service found a legacy proxy without graceful restart support; ownership transfer is deferred until it stops.");
      return;
    }
    console.error(`Provider proxy service could not request graceful ownership transfer: HTTP ${response.status}`);
  } catch (error) {
    console.error(`Provider proxy service could not request graceful ownership transfer: ${error?.message || error}`);
  }
}

function beginShutdown() {
  if (stopping) return;
  stopping = true;
  requestOwnedProxyStop().catch((error) => {
    console.error(`Provider proxy service shutdown failed: ${error?.message || error}`);
  });
}

process.once("SIGTERM", beginShutdown);
process.once("SIGINT", beginShutdown);

function spawnProxy() {
  child = spawn(process.execPath, [wrapper, "proxy", "serve"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_AUTH_ADVANCED_NODE_EXECUTABLE: process.execPath,
      CODEX_AUTH_ADVANCED_PROVIDER_PROXY_CHILD: "1",
      CODEX_AUTH_ADVANCED_PROVIDER_PROXY_SERVICE_CHILD: "1"
    },
    stdio: "inherit"
  });
  childExit = new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
    child.once("close", (code, signal) => resolve({ code, signal, error: null }));
  });
  return childExit;
}

while (!stopping) {
  const { health } = await readProxyHealth(runtime, 1000);
  if (health) {
    if (!takeoverRequested
      && health.restart_requested !== true
      && Number(health.active_requests || 0) === 0
      && Number(health.active_upgrades || 0) === 0) {
      await requestExternalProxyTakeover();
    }
    await sleep(500);
    continue;
  }

  takeoverRequested = false;
  const result = await spawnProxy();
  child = null;
  childExit = null;
  if (stopping) break;
  if (result.error) {
    console.error(`Provider proxy service could not start the proxy: ${result.error.message}`);
  } else if ((result.code ?? 1) !== 0 || result.signal) {
    console.error(`Provider proxy exited with ${result.signal || result.code}; retrying.`);
  }
  await sleep(500);
}

if (childExit) await childExit;
