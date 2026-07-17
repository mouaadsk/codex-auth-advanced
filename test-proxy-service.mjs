import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const repoRoot = new URL(".", import.meta.url).pathname;
const wrapper = path.join(repoRoot, "bin", "codex-auth-advanced.js");
const serviceRunner = path.join(repoRoot, "scripts", "run-proxy-service.mjs");
const restartScript = path.join(repoRoot, "scripts", "restart-proxy.mjs");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-advanced-service-"));
const fakeBin = path.join(tempRoot, "bin");
const home = path.join(tempRoot, "home");
fs.mkdirSync(fakeBin, { recursive: true, mode: 0o700 });
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
const fakeLaunchctl = path.join(fakeBin, "launchctl");
fs.writeFileSync(fakeLaunchctl, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
fs.chmodSync(fakeLaunchctl, 0o755);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function readHealth(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/_codex-auth-advanced/health`);
    if (response.status !== 200) return null;
    return response.json();
  } catch {
    return null;
  }
}

async function waitForHealth(port, predicate = () => true, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const health = await readHealth(port);
    if (health && predicate(health)) return health;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("managed provider proxy did not become healthy");
}

function waitForExit(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timeout = setTimeout(() => reject(new Error("provider proxy service did not exit gracefully")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

function runRestart(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [restartScript], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if ((code ?? 1) !== 0 || signal) {
        reject(new Error(`managed restart failed with ${signal || code}:\n${stdout}\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

const reserved = http.createServer();
const proxyPort = await listen(reserved);
await new Promise((resolve) => reserved.close(resolve));
const env = {
  ...process.env,
  HOME: home,
  CODEX_HOME: path.join(home, ".codex"),
  CODEX_AUTH_ADVANCED_PROXY_PORT: String(proxyPort),
  PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`
};
const unmanaged = spawn(process.execPath, [wrapper, "proxy", "serve"], {
  cwd: repoRoot,
  env,
  stdio: ["ignore", "pipe", "pipe"]
});
let unmanagedOutput = "";
unmanaged.stdout.on("data", (chunk) => { unmanagedOutput += chunk.toString("utf8"); });
unmanaged.stderr.on("data", (chunk) => { unmanagedOutput += chunk.toString("utf8"); });
const unmanagedHealth = await waitForHealth(proxyPort);
const service = spawn(process.execPath, [serviceRunner], {
  cwd: repoRoot,
  env,
  stdio: ["ignore", "pipe", "pipe"]
});
let serviceOutput = "";
service.stdout.on("data", (chunk) => { serviceOutput += chunk.toString("utf8"); });
service.stderr.on("data", (chunk) => { serviceOutput += chunk.toString("utf8"); });

try {
  const unmanagedStopped = await waitForExit(unmanaged);
  if ((unmanagedStopped.code ?? 0) !== 0 || unmanagedStopped.signal) {
    throw new Error(`unmanaged proxy did not transfer gracefully: ${unmanagedStopped.signal || unmanagedStopped.code}\n${unmanagedOutput}`);
  }
  const firstHealth = await waitForHealth(proxyPort, (health) => health.started_at_ms !== unmanagedHealth.started_at_ms);
  const restart = await runRestart(env);
  if (!restart.stdout.includes("managed by launchd")) {
    throw new Error(`restart script did not use managed mode:\n${restart.stdout}\n${restart.stderr}`);
  }
  const secondHealth = await waitForHealth(proxyPort, (health) => health.started_at_ms !== firstHealth.started_at_ms);
  if (secondHealth.started_at_ms === firstHealth.started_at_ms) {
    throw new Error("managed restart did not replace the proxy process");
  }

  service.kill("SIGTERM");
  const stopped = await waitForExit(service);
  if ((stopped.code ?? 0) !== 0 || stopped.signal) {
    throw new Error(`provider proxy service exited abnormally with ${stopped.signal || stopped.code}:\n${serviceOutput}`);
  }
  for (let attempt = 0; attempt < 50 && await readHealth(proxyPort); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (await readHealth(proxyPort)) {
    throw new Error("provider proxy remained active after the service drained and stopped");
  }
} catch (error) {
  if (unmanaged.exitCode === null && unmanaged.signalCode === null) {
    await fetch(`http://127.0.0.1:${proxyPort}/_codex-auth-advanced/restart`, { method: "POST" }).catch(() => {});
    await waitForExit(unmanaged).catch(() => {});
  }
  if (service.exitCode === null && service.signalCode === null) {
    service.kill("SIGTERM");
    await waitForExit(service).catch(() => {});
  }
  throw error;
}

console.log("managed provider proxy lifecycle ok");
