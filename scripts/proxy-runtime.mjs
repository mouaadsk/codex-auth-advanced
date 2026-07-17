import { spawnSync } from "node:child_process";
import path from "node:path";

export const proxyLaunchAgentLabel = "com.mouaadsk.codex-auth-advanced.proxy";
export const providerProxyPrefix = "/_codex-auth-advanced";

export function proxyRuntime(env = process.env) {
  const host = env.CODEX_AUTH_ADVANCED_PROXY_HOST || "127.0.0.1";
  const port = Number(env.CODEX_AUTH_ADVANCED_PROXY_PORT || 47778);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid CODEX_AUTH_ADVANCED_PROXY_PORT: ${env.CODEX_AUTH_ADVANCED_PROXY_PORT}`);
  }
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const origin = `http://${formattedHost}:${port}`;
  const baseUrl = `${origin}${providerProxyPrefix}`;
  return {
    host,
    port,
    origin,
    baseUrl,
    healthUrl: `${baseUrl}/health`,
    restartUrl: `${baseUrl}/restart`
  };
}

export function providerProxyGroupId(codexHome) {
  return Buffer.from(path.resolve(codexHome), "utf8").toString("base64url");
}

export function providerProxyBaseUrl(codexHome, runtime = proxyRuntime()) {
  return `${runtime.baseUrl}/${providerProxyGroupId(codexHome)}`;
}

export async function readProxyHealth(runtime = proxyRuntime(), timeoutMs = 3000) {
  try {
    const response = await fetch(runtime.healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) {
      return { health: null, status: response.status, error: `HTTP ${response.status}` };
    }
    return { health: await response.json(), status: response.status, error: null };
  } catch (error) {
    const cause = error?.cause
      ? `; cause: ${error.cause?.code || error.cause?.name || "Error"}: ${error.cause?.message || error.cause}`
      : "";
    return {
      health: null,
      status: null,
      error: `${error?.name || "Error"}: ${error?.message || error}${cause}`
    };
  }
}

export function macLaunchAgentDomain({ platform = process.platform, uid = typeof process.getuid === "function" ? process.getuid() : null } = {}) {
  if (platform !== "darwin" || uid == null) return null;
  return `gui/${uid}`;
}

export function proxyLaunchAgentIsLoaded({ env = process.env, platform = process.platform } = {}) {
  const domain = macLaunchAgentDomain({ platform });
  if (!domain) return false;
  const child = spawnSync("launchctl", ["print", `${domain}/${proxyLaunchAgentLabel}`], {
    env,
    stdio: ["ignore", "ignore", "ignore"]
  });
  return !child.error && !child.signal && (child.status ?? 1) === 0;
}

export function kickstartProxyLaunchAgent({ env = process.env, platform = process.platform } = {}) {
  const domain = macLaunchAgentDomain({ platform });
  if (!domain) return false;
  const child = spawnSync("launchctl", ["kickstart", `${domain}/${proxyLaunchAgentLabel}`], {
    env,
    stdio: ["ignore", "ignore", "ignore"]
  });
  return !child.error && !child.signal && (child.status ?? 1) === 0;
}
