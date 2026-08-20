// Pure routing / target / URL helpers for the provider proxy. None of these
// touch the proxy closure state, so they live outside createProviderProxy.

import path from "node:path";
import { isVsllmClaudeGatewayModel } from "./claude-gateway.mjs";

export function providerProxyGroupId(codexHome) {
    return Buffer.from(path.resolve(codexHome), "utf8").toString("base64url");
  }


export function codexHomeFromProviderProxyGroupId(groupId) {
    return Buffer.from(String(groupId || ""), "base64url").toString("utf8");
  }


export function providerProxyBaseUrl(host, port, prefix, codexHome) {
    return `http://${host}:${port}${prefix}/${providerProxyGroupId(codexHome)}`;
  }


export function providerProxyAccountBaseUrl(host, port, prefix, codexHome, account) {
    const accountKey = typeof account?.account_key === "string" ? account.account_key.trim() : "";
    if (!accountKey) return null;
    return `${providerProxyBaseUrl(host, port, prefix, codexHome)}/accounts/${encodeURIComponent(accountKey)}/v1`;
  }


export function providerProxyHealthUrl(host, port, prefix) {
    return `http://${host}:${port}${prefix}/health`;
  }


export function isProviderProxyBaseUrl(url, host, port, prefix) {
    try {
      const parsed = new URL(String(url || ""));
      const expectedPort = String(port);
      const actualPort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
      return parsed.hostname === host
        && actualPort === expectedPort
        && parsed.pathname.startsWith(`${prefix}/`);
    } catch {
      return false;
    }
  }


export function isTransientApiFailureStatus(status) {
    return status === 502 || status === 503 || status === 504 || status === 524;
  }


export function proxyRequestTargetUrl(req, codexHome, target, routePath, providerProxyHost, providerProxyPort) {
    const incoming = new URL(req.url || "/", `http://${providerProxyHost}:${providerProxyPort}`);
    let rest = incoming.pathname.startsWith(routePath)
      ? incoming.pathname.slice(routePath.length)
      : incoming.pathname;
    if (!rest.startsWith("/")) rest = `/${rest}`;
    if (rest === "/") rest = "";

    const requestedV1 = rest === "/v1" || rest.startsWith("/v1/");
    if (requestedV1) {
      rest = rest === "/v1" ? "" : rest.slice(3);
    }

    const isTargetNeedV1 = requestedV1 || rest === "/responses" || rest.startsWith("/responses/") || rest === "/chat/completions" || rest.startsWith("/chat/completions/");
    if (isTargetNeedV1 && target.upstreamBaseUrl && !target.upstreamBaseUrl.includes("/v1")) {
      rest = `/v1${rest}`;
    }

    return {
      ...target,
      url: `${target.upstreamBaseUrl}${rest}${incoming.search}`
    };
  }


export function isClaudeMessagesTarget(target) {
    try {
      const pathname = new URL(target?.url || "").pathname.replace(/\/$/, "");
      return pathname.endsWith("/v1/messages") || pathname.endsWith("/v1/messages/count_tokens");
    } catch {
      return false;
    }
  }


export function isOfficialClaudeModel(model) {
    const normalized = String(model || "").trim().toLowerCase().replace(/\[1m\]$/i, "");
    if (!normalized || isVsllmClaudeGatewayModel(model)) return false;
    return /^(claude|anthropic)-/.test(normalized)
      || ["default", "best", "fable", "fable-5", "opus", "sonnet", "haiku", "opusplan"].includes(normalized);
  }


export function providerProxyRouteFromIncoming(incoming, providerProxyPrefix) {
    const pathMatch = incoming.pathname.match(new RegExp(`^${providerProxyPrefix.replaceAll("/", "\\/")}\\/([^/]+)(?:\\/|$)`));
    if (!pathMatch) {
      return { error: "Unknown codex-auth-advanced proxy route.", status: 404 };
    }

    const groupId = pathMatch[1];
    let codexHome = "";
    try {
      codexHome = codexHomeFromProviderProxyGroupId(groupId);
    } catch {
      return { error: "Invalid codex-auth-advanced proxy group id.", status: 400 };
    }

    const groupPath = `${providerProxyPrefix}/${groupId}`;
    const remainder = incoming.pathname.slice(groupPath.length);
    if (remainder === "/accounts" || remainder.startsWith("/accounts/")) {
      const accountMatch = remainder.match(/^\/accounts\/([^/]+)(?:\/|$)/);
      if (!accountMatch) {
        return { error: "Pinned proxy routes require an account key or alias after /accounts/.", status: 400 };
      }

      let accountSelector = "";
      try {
        accountSelector = decodeURIComponent(accountMatch[1]).trim();
      } catch {
        return { error: "Invalid encoded account selector in pinned proxy route.", status: 400 };
      }
      if (!accountSelector || accountSelector.includes("/")) {
        return { error: "Invalid pinned proxy account selector.", status: 400 };
      }

      return {
        codexHome,
        accountSelector,
        pathPrefix: `${groupPath}/accounts/${accountMatch[1]}`
      };
    }

    return { codexHome, accountSelector: null, pathPrefix: groupPath };
  }



// Derive the per-shape endpoint URL on the same upstream. Used by the chain
// walker to retarget a failing request to a different wire shape on the same
// account without touching the registry. Returns null when the shape has no
// URL suffix that can be swapped on the given upstream.
export function shapeUrlFor(baseUrl, shape) {
  const raw = String(baseUrl || "").replace(/\/$/, "");
  if (!raw) return null;
  // If baseUrl already includes the /v1 prefix, don't add it again.
  const base = /\/v1$/.test(raw) ? raw : `${raw}/v1`;
  if (shape === "responses") return `${base}/responses`;
  if (shape === "responses_compact") return `${base}/responses/compact`;
  if (shape === "messages") return `${base}/messages`;
  if (shape === "chat_completions") return `${base}/chat/completions`;
  return null;
}
