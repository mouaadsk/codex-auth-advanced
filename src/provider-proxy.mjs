import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { readClonedResponseBody } from "./provider-client.mjs";
import {
  claudeGatewayModelsResponse,
  isClaudeGatewayModelsRequest
} from "./claude-gateway.mjs";
import {
  createClaudeResponsesSseTransformStream,
  prepareClaudeResponsesBridge,
  retargetClaudeResponsesBridge,
  translateResponsesResponseToClaude
} from "./claude-responses-bridge.mjs";
import {
  apiProviderExhaustionReason,
  apiProviderTransientRetryReason,
  isInvalidEncryptedContentBody
} from "./provider-policy.mjs";
import {
  createSseResponseTransformStream,
  createStreamDiagnostics,
  dummyCompactionResponse,
  isCompactProxyTarget,
  isResponsesProxyTarget,
  repairProviderProxyBodyPlaintext,
  rewriteProviderProxyRequestBody,
  runLocalCompactionFallback
} from "./proxy-transforms.mjs";
import { ensureDir, userHome } from "./storage.mjs";

const providerProxyScriptPath = fileURLToPath(new URL("../bin/codex-auth-advanced.js", import.meta.url));

export function createProviderProxy(options) {
  const providerProxyHost = options.host;
  const providerProxyPort = options.port;
  const providerProxyPrefix = options.prefix;
  const activeApiProxyTarget = options.activeApiProxyTarget;
  const pinnedApiProxyTarget = options.pinnedApiProxyTarget;
  const markApiAccountExhaustedFromProxy = options.markApiAccountExhaustedFromProxy;
  const switchFromExhaustedApiAccount = options.switchFromExhaustedApiAccount;
  const targetFromTransientApiFailure = options.targetFromTransientApiFailure;
  const vsllmTransientUsageLimitMaxRetries = options.vsllmTransientUsageLimitMaxRetries;
  const vsllmTransientUsageLimitRetryDelayMs = options.vsllmTransientUsageLimitRetryDelayMs;
  const modelCapacityMaxRetries = options.modelCapacityMaxRetries;
  const modelCapacityRetryBaseDelayMs = options.modelCapacityRetryBaseDelayMs;

  const chatgptCloudflareCookies = new Map();
  let providerProxyServer = null;
  let providerProxyStartedAtMs = null;
  let providerProxyRestartRequested = false;
  let providerProxyRestartClosing = false;
  let providerProxyActiveRequests = 0;
  let providerProxyActiveUpgrades = 0;

  function providerProxyGroupId(codexHome) {
    return Buffer.from(path.resolve(codexHome), "utf8").toString("base64url");
  }

  function codexHomeFromProviderProxyGroupId(groupId) {
    return Buffer.from(String(groupId || ""), "base64url").toString("utf8");
  }

  function providerProxyBaseUrl(codexHome) {
    return `http://${providerProxyHost}:${providerProxyPort}${providerProxyPrefix}/${providerProxyGroupId(codexHome)}`;
  }

  function providerProxyAccountBaseUrl(codexHome, account) {
    const accountKey = typeof account?.account_key === "string" ? account.account_key.trim() : "";
    if (!accountKey) return null;
    return `${providerProxyBaseUrl(codexHome)}/accounts/${encodeURIComponent(accountKey)}/v1`;
  }

  function providerProxyHealthUrl() {
    return `http://${providerProxyHost}:${providerProxyPort}${providerProxyPrefix}/health`;
  }

  function providerProxyActiveOperationCount() {
    return providerProxyActiveRequests + providerProxyActiveUpgrades;
  }

  function isProviderProxyLoopbackRequest(req) {
    const address = String(req.socket?.remoteAddress || "");
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  }

  function writeProviderProxyControlResponse(res, status, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      ...extraHeaders
    });
    res.end(body);
  }

  function providerProxyHealthPayload() {
    return {
      ok: true,
      started_at_ms: providerProxyStartedAtMs,
      restart_requested: providerProxyRestartRequested,
      active_requests: providerProxyActiveRequests,
      active_upgrades: providerProxyActiveUpgrades
    };
  }

  function maybeCompleteGracefulProviderProxyRestart() {
    if (!providerProxyRestartRequested || providerProxyRestartClosing || providerProxyActiveOperationCount() > 0) return;
    const server = providerProxyServer;
    if (!server) return;

    providerProxyRestartClosing = true;
    server.close((error) => {
      if (error) {
        process.stderr.write(`Provider proxy graceful restart failed: ${error?.message || error}\n`);
        process.exit(1);
      }
      process.stdout.write("codex-auth-advanced provider proxy stopped for graceful restart\n");
      process.exit(0);
    });
    // Do not keep idle HTTP connections alive once all active streams have drained.
    server.closeIdleConnections?.();
  }

  function trackProviderProxyRequest(res) {
    providerProxyActiveRequests += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      providerProxyActiveRequests = Math.max(0, providerProxyActiveRequests - 1);
      maybeCompleteGracefulProviderProxyRestart();
    };
    res.once("finish", release);
    res.once("close", release);
  }

  function trackProviderProxyUpgrade(socket) {
    providerProxyActiveUpgrades += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      providerProxyActiveUpgrades = Math.max(0, providerProxyActiveUpgrades - 1);
      maybeCompleteGracefulProviderProxyRestart();
    };
    socket.once("close", release);
    socket.once("error", release);
  }

  function isProviderProxyBaseUrl(baseUrl) {
    try {
      const parsed = new URL(String(baseUrl || ""));
      const expectedPort = String(providerProxyPort);
      const actualPort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
      return parsed.hostname === providerProxyHost
        && actualPort === expectedPort
        && parsed.pathname.startsWith(`${providerProxyPrefix}/`);
    } catch {
      return false;
    }
  }

  function isTransientApiFailureStatus(status) {
    return status === 502 || status === 503 || status === 504;
  }

  function proxyRequestTargetUrl(req, codexHome, target, routePath = `${providerProxyPrefix}/${providerProxyGroupId(codexHome)}`) {
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

  function targetUrlForProxyRequest(req, route) {
    const target = route.accountSelector
      ? pinnedApiProxyTarget(route.codexHome, route.accountSelector)
      : activeApiProxyTarget(route.codexHome);
    if (target.error) return target;
    return proxyRequestTargetUrl(req, route.codexHome, target, route.pathPrefix);
  }

  function providerProxyRouteFromIncoming(incoming) {
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

  function stripHopByHopHeaders(headers) {
    const out = {};
    for (const [key, value] of Object.entries(headers || {})) {
      if (Array.isArray(value)) out[key] = value.join(", ");
      else if (value != null) out[key] = String(value);
    }
    for (const name of [
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
      "host",
      "content-length"
    ]) {
      delete out[name];
    }
    return out;
  }

  function stripProxyResponseHeaders(headers) {
    const out = {};
    headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if ([
        "connection",
        "content-encoding",
        "content-length",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade"
      ].includes(lower)) {
        return;
      }
      out[key] = value;
    });
    return out;
  }

  function isAllowedCloudflareCookieName(name) {
    return [
      "__cf_bm",
      "__cflb",
      "__cfruid",
      "__cfseq",
      "__cfwaitingroom",
      "_cfuvid",
      "cf_clearance",
      "cf_ob_info",
      "cf_use_ob"
    ].includes(name) || name.startsWith("cf_chl_");
  }

  function cookieNameFromSetCookie(header) {
    const name = String(header || "").split("=", 1)[0]?.trim();
    return name || null;
  }

  function responseSetCookieHeaders(headers) {
    if (!headers) return [];
    if (typeof headers.getSetCookie === "function") {
      return headers.getSetCookie();
    }
    const setCookie = headers["set-cookie"] ?? headers["Set-Cookie"];
    if (Array.isArray(setCookie)) return setCookie;
    if (typeof setCookie === "string" && setCookie.length > 0) return [setCookie];
    return [];
  }

  function captureChatgptCloudflareCookies(headers) {
    for (const header of responseSetCookieHeaders(headers)) {
      const name = cookieNameFromSetCookie(header);
      if (!name || !isAllowedCloudflareCookieName(name)) continue;
      const value = String(header).split(";", 1)[0]?.trim();
      if (value) chatgptCloudflareCookies.set(name, value);
    }
  }

  function chatgptCloudflareCookieHeader() {
    return [...chatgptCloudflareCookies.values()].join("; ");
  }

  function writeProxyError(res, status, message) {
    const body = JSON.stringify({ error: { message, type: "codex_auth_advanced_proxy" } });
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body)
    });
    res.end(body);
  }

  function writeProxySocketError(socket, status, message) {
    if (socket.destroyed || !socket.writable) return;
    const body = JSON.stringify({ error: { message, type: "codex_auth_advanced_proxy" } });
    const statusMessage = http.STATUS_CODES[status] || "Error";
    socket.end([
      `HTTP/1.1 ${status} ${statusMessage}`,
      "content-type: application/json",
      `content-length: ${Buffer.byteLength(body)}`,
      "connection: close",
      "",
      body
    ].join("\r\n"));
  }

  function sanitizeProxyRequestHeaders(headers, target, { websocket = false, omitContentEncoding = false } = {}) {
    const out = {};
    for (const [key, value] of Object.entries(headers || {})) {
      const lower = key.toLowerCase();
      if (lower === "host" || lower === "content-length") continue;
      if (omitContentEncoding && lower === "content-encoding") continue;
      if (lower === "proxy-authenticate" || lower === "proxy-authorization" || lower === "proxy-connection" || lower === "te" || lower === "trailer" || lower === "transfer-encoding") continue;
      if (!websocket && (lower === "connection" || lower === "upgrade")) continue;
      if (lower === "accept-encoding" && websocket) continue;
      if (!target.chatgpt) {
        if (lower === "authorization" || lower === "x-api-key") continue;
        if (lower === "cookie" || lower === "x-authorization" || lower === "referer" || lower === "origin" || lower.startsWith("oai-") || (!websocket && lower.startsWith("sec-"))) continue;
        if (target.claudeResponsesBridge && (lower.startsWith("anthropic-") || lower.startsWith("x-stainless-"))) continue;
      } else if (lower === "authorization" || lower === "x-authorization") {
        continue;
      }
      out[key] = Array.isArray(value) ? value.join(", ") : String(value);
    }

    if (!target.chatgpt) {
      out["accept-encoding"] = "identity";
    }

    if (target.claudeResponsesBridge) {
      out.accept = "text/event-stream, application/json";
    }

    if (!target.chatgpt) {
      out.authorization = `Bearer ${target.apiKey}`;
    } else if (target.accessToken) {
      out.authorization = `Bearer ${target.accessToken}`;
    }

    if (target.chatgpt && chatgptCloudflareCookies.size > 0) {
      const existingCookie = out.cookie ? `${out.cookie}; ` : "";
      out.cookie = `${existingCookie}${chatgptCloudflareCookieHeader()}`;
    }

    out["user-agent"] = out["user-agent"] || "codex-auth-advanced-proxy";
    return out;
  }

  async function readProxyRequestBody(req) {
    if (["GET", "HEAD"].includes(req.method || "GET")) return undefined;
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async function fetchProviderTarget(req, target, body, options = {}) {
    const timeoutMs = Number(options.timeout);
    const signal = Number.isFinite(timeoutMs) && timeoutMs > 0 && typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
    const headers = sanitizeProxyRequestHeaders(req.headers, target, {
      omitContentEncoding: options.omitContentEncoding === true
    });
    if (body != null) {
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    return fetch(target.url, {
      method: req.method,
      headers,
      body,
      duplex: body == null ? undefined : "half",
      signal
    });
  }

  async function exhaustedApiResponse(upstream, account = null) {
    if (upstream.status < 400 || (upstream.status >= 500 && upstream.status !== 503)) {
      return { exhausted: false, body: null, transientRetryReason: null };
    }

    const body = await readClonedResponseBody(upstream);
    const transientRetryReason = apiProviderTransientRetryReason(upstream.status, body, account);
    if (transientRetryReason) {
      return {
        exhausted: false,
        body,
        reason: null,
        transientRetryReason
      };
    }
    const exhaustionReason = apiProviderExhaustionReason(upstream.status, body, account);
    return {
      exhausted: exhaustionReason != null,
      body,
      reason: exhaustionReason,
      transientRetryReason: null
    };
  }

  async function invalidEncryptedContentResponse(upstream) {
    if (![400, 422].includes(upstream.status)) {
      return { invalid: false, body: null };
    }
    const body = await readClonedResponseBody(upstream);
    return {
      invalid: isInvalidEncryptedContentBody(body),
      body
    };
  }

  function writeProxySocketResponseHead(socket, status, headers, { allowUpgrade = false } = {}) {
    const statusMessage = http.STATUS_CODES[status] || "OK";
    socket.write(`HTTP/1.1 ${status} ${statusMessage}\r\n`);
    for (const [key, value] of Object.entries(headers || {})) {
      const lower = key.toLowerCase();
      if (lower === "host" || lower === "content-length" || lower === "keep-alive" || lower === "proxy-authenticate" || lower === "proxy-authorization" || lower === "te" || lower === "trailer" || lower === "transfer-encoding") {
        continue;
      }
      if (!allowUpgrade && (lower === "connection" || lower === "upgrade")) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item != null) socket.write(`${key}: ${item}\r\n`);
        }
        continue;
      }
      if (value != null) socket.write(`${key}: ${value}\r\n`);
    }
    socket.write("\r\n");
  }

  function bindProxySocketTunnel(clientSocket, upstreamSocket) {
    const destroyPeer = (peer) => () => {
      if (!peer.destroyed) peer.destroy();
    };
    clientSocket.on("error", destroyPeer(upstreamSocket));
    upstreamSocket.on("error", destroyPeer(clientSocket));
    clientSocket.on("close", destroyPeer(upstreamSocket));
    upstreamSocket.on("close", destroyPeer(clientSocket));
    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
  }

  async function handleProviderProxyUpgrade(req, socket, head) {
    const incoming = new URL(req.url || "/", `http://${providerProxyHost}:${providerProxyPort}`);
    if (incoming.pathname === `${providerProxyPrefix}/health`) {
      writeProxySocketError(socket, 400, "WebSocket upgrades are not supported on the health route.");
      return;
    }

    const route = providerProxyRouteFromIncoming(incoming);
    if (route.error) {
      writeProxySocketError(socket, route.status || 400, route.error);
      return;
    }

    const target = targetUrlForProxyRequest(req, route);
    if (target.error) {
      writeProxySocketError(socket, target.status || 500, target.error);
      return;
    }
    if (!target.chatgpt) {
      writeProxySocketError(socket, 426, "WebSocket transport is not supported for API-key provider proxy targets.");
      return;
    }

    try {
      const upstreamUrl = new URL(target.url);
      const headers = sanitizeProxyRequestHeaders(req.headers, target, { websocket: true });
      const requestHeaders = {
        ...headers,
        host: upstreamUrl.host
      };

      const requestOptions = {
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port,
        method: req.method || "GET",
        path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
        headers: requestHeaders
      };

      const client = upstreamUrl.protocol === "https:" ? https : http;
      const upstreamRequest = client.request(requestOptions);

      upstreamRequest.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
        if (target.chatgpt) {
          captureChatgptCloudflareCookies(upstreamRes.headers);
        }
        writeProxySocketResponseHead(socket, upstreamRes.statusCode || 101, upstreamRes.headers, { allowUpgrade: true });
        if (upstreamHead?.length) socket.write(upstreamHead);
        if (head?.length) upstreamSocket.write(head);
        bindProxySocketTunnel(socket, upstreamSocket);
      });

      upstreamRequest.on("response", (upstreamRes) => {
        if (target.chatgpt) {
          captureChatgptCloudflareCookies(upstreamRes.headers);
        }
        writeProxySocketResponseHead(socket, upstreamRes.statusCode || 500, upstreamRes.headers);
        upstreamRes.pipe(socket);
      });

      upstreamRequest.on("error", (error) => {
        writeProxySocketError(socket, 502, `Provider proxy request failed: ${error?.message || error}`);
      });

      upstreamRequest.end();
    } catch (error) {
      writeProxySocketError(socket, 502, `Provider proxy request failed: ${error?.message || error}`);
    }
  }

  async function handleProviderProxyRequest(req, res) {
    const incoming = new URL(req.url || "/", `http://${providerProxyHost}:${providerProxyPort}`);
    if (incoming.pathname === `${providerProxyPrefix}/health`) {
      writeProviderProxyControlResponse(res, 200, providerProxyHealthPayload());
      return;
    }
    if (incoming.pathname === `${providerProxyPrefix}/restart`) {
      if (req.method !== "POST") {
        writeProviderProxyControlResponse(res, 405, { error: "Use POST to request a graceful provider proxy restart." }, { allow: "POST" });
        return;
      }
      if (!isProviderProxyLoopbackRequest(req)) {
        writeProviderProxyControlResponse(res, 403, { error: "Provider proxy restart is only available from loopback." });
        return;
      }

      providerProxyRestartRequested = true;
      res.once("finish", maybeCompleteGracefulProviderProxyRestart);
      writeProviderProxyControlResponse(res, 202, {
        ...providerProxyHealthPayload(),
        message: "Provider proxy is draining active requests before restart."
      });
      return;
    }
    if (providerProxyRestartRequested) {
      writeProxyError(res, 503, "Provider proxy is restarting; retry after it becomes healthy.");
      return;
    }

    trackProviderProxyRequest(res);

    const route = providerProxyRouteFromIncoming(incoming);
    if (route.error) {
      writeProxyError(res, route.status || 400, route.error);
      return;
    }

    let target = targetUrlForProxyRequest(req, route);
    if (target.error) {
      writeProxyError(res, target.status || 500, target.error);
      return;
    }

    try {
      if ((req.method || "GET") === "GET" && isClaudeGatewayModelsRequest(target, req.headers)) {
        const catalog = claudeGatewayModelsResponse();
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(catalog)
        });
        res.end(catalog);
        return;
      }
      console.log(`[Proxy Request] ${req.method} ${req.url} -> target: ${target.url}`);
      let body = await readProxyRequestBody(req);
      let upstream = null;
      const attemptedAccountKeys = new Set();
      const transientUsageLimitRetries = new Map();
      const modelCapacityRetries = new Map();
      let bodyAlreadyDecoded = false;
      let triedPlaintextCompactRepair = false;
      let claudeResponsesBridge = null;
      const rewrittenBody = rewriteProviderProxyRequestBody(target, body, req.headers);
      if (rewrittenBody.rewritten) {
        body = rewrittenBody.body;
        bodyAlreadyDecoded = rewrittenBody.decoded === true;
        if (isCompactProxyTarget(target)) {
          console.log("[Proxy] Rewrote compact request body for provider compatibility.");
        }
      } else if (rewrittenBody.decoded) {
        body = rewrittenBody.body;
        bodyAlreadyDecoded = true;
      }
      claudeResponsesBridge = prepareClaudeResponsesBridge(target, body);
      if (claudeResponsesBridge?.kind === "count_tokens") {
        const responseBody = Buffer.from(JSON.stringify({ input_tokens: claudeResponsesBridge.inputTokens }), "utf8");
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": responseBody.length
        });
        res.end(responseBody);
        return;
      }
      if (claudeResponsesBridge?.kind === "responses") {
        target = claudeResponsesBridge.target;
        body = claudeResponsesBridge.body;
        bodyAlreadyDecoded = true;
        console.log(`[Proxy] Bridging Claude Messages model ${claudeResponsesBridge.originalRequest.model} through OpenAI Responses.`);
      }
      while (true) {
        if (target.account?.account_key) attemptedAccountKeys.add(target.account.account_key);

        let fetchFailed = false;
        let fetchError = null;
        try {
          upstream = await fetchProviderTarget(req, target, body, {
            omitContentEncoding: bodyAlreadyDecoded,
            timeout: (isCompactProxyTarget(target) && !target.chatgpt) ? 15000 : undefined
          });
        } catch (err) {
          fetchFailed = true;
          fetchError = err;
        }

        if (target.chatgpt && !fetchFailed) {
          captureChatgptCloudflareCookies(upstream.headers);
          break;
        }

        if (isCompactProxyTarget(target) && (fetchFailed || [502, 503, 504, 524, 404, 405].includes(upstream.status))) {
          console.log(`[Proxy] Compaction failed or timed out (fetchFailed: ${fetchFailed}, status: ${upstream?.status}, error: ${fetchError?.message}). Triggering local compaction fallback...`);
          let localCompacted = await runLocalCompactionFallback(
            target,
            body,
            req.headers,
            bodyAlreadyDecoded,
            sanitizeProxyRequestHeaders
          );
          if (!localCompacted) {
            console.warn(`[Proxy] Local compaction fallback failed during error handler. Generating dummy placeholder...`);
            localCompacted = dummyCompactionResponse(fetchError?.message || `Upstream status ${upstream?.status}`);
          }
          if (localCompacted) {
            upstream = localCompacted;
            break;
          }
        }

        if (fetchFailed) {
          throw fetchError;
        }

        if (target.repairInvalidEncryptedContent && isCompactProxyTarget(target) && !triedPlaintextCompactRepair) {
          const { invalid } = await invalidEncryptedContentResponse(upstream);
          if (invalid) {
            const stripped = repairProviderProxyBodyPlaintext(target, body, req.headers, {
              alreadyDecoded: bodyAlreadyDecoded
            });
            if (stripped.repaired) {
              body = stripped.body;
              bodyAlreadyDecoded = bodyAlreadyDecoded || stripped.decoded === true;
              triedPlaintextCompactRepair = true;
              continue;
            }
          }
        }

        const {
          exhausted,
          body: responseBody,
          reason: exhaustionReason,
          transientRetryReason
        } = await exhaustedApiResponse(upstream, target.account);
        if (transientRetryReason === "vsllm_usage_limit") {
          const accountKey = target.account?.account_key || target.url;
          const retries = transientUsageLimitRetries.get(accountKey) || 0;
          if (retries < vsllmTransientUsageLimitMaxRetries) {
            transientUsageLimitRetries.set(accountKey, retries + 1);
            const label = target.account?.alias || target.account?.email || target.account?.account_key || "VSLLM";
            console.warn(`[Proxy] ${label} returned a transient usage-limit response; retrying the same account.`);
            await new Promise((resolve) => setTimeout(resolve, vsllmTransientUsageLimitRetryDelayMs));
            continue;
          }
        }
        if (transientRetryReason === "model_capacity") {
          const accountKey = target.account?.account_key || target.url;
          const retries = modelCapacityRetries.get(accountKey) || 0;
          if (retries < modelCapacityMaxRetries) {
            modelCapacityRetries.set(accountKey, retries + 1);
            const delayMs = modelCapacityRetryBaseDelayMs * (2 ** retries);
            const label = target.account?.alias || target.account?.email || target.account?.account_key || "provider";
            console.warn(`[Proxy] ${label} reported model capacity; retrying the same account in ${delayMs}ms (${retries + 1}/${modelCapacityMaxRetries}).`);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }
        }
        if (route.accountSelector && exhausted) {
          markApiAccountExhaustedFromProxy(route.codexHome, target.account, upstream.status, responseBody);
        }
        const shouldFailOver = !route.accountSelector && (exhausted || transientRetryReason != null || isTransientApiFailureStatus(upstream.status));
        if (!shouldFailOver) break;

        const retryTarget = exhausted
          ? await (async () => {
            const switched = await switchFromExhaustedApiAccount(route.codexHome, target.account, upstream.status, responseBody, {
              excludeAccountKeys: attemptedAccountKeys,
              force: exhaustionReason === "no_active_subscription"
            });
            return switched
              ? targetUrlForProxyRequest(req, { ...route, accountSelector: null, pathPrefix: `${providerProxyPrefix}/${providerProxyGroupId(route.codexHome)}` })
              : null;
          })()
          : await targetFromTransientApiFailure(route.codexHome, req, {
            excludeAccountKeys: attemptedAccountKeys
          });
        if (!retryTarget) break;
        if (retryTarget.error || retryTarget.account?.account_key === target.account?.account_key || attemptedAccountKeys.has(retryTarget.account?.account_key)) {
          break;
        }
        target = retargetClaudeResponsesBridge(retryTarget, claudeResponsesBridge);
      }

      console.log(`[Proxy Response] ${req.url} -> status: ${upstream.status}`);
      if (!upstream.body) {
        res.writeHead(upstream.status, stripProxyResponseHeaders(upstream.headers));
        res.end();
        return;
      }
      const contentType = String(upstream.headers.get("content-type") || "").toLowerCase();
      if (claudeResponsesBridge?.kind === "responses"
        && upstream.status >= 200
        && upstream.status < 300
        && !contentType.includes("event-stream")) {
        const rawBody = await upstream.text();
        let translatedBody = null;
        try {
          translatedBody = translateResponsesResponseToClaude(JSON.parse(rawBody), claudeResponsesBridge.originalRequest);
        } catch {
          translatedBody = null;
        }
        const responseBody = Buffer.from(translatedBody ? JSON.stringify(translatedBody) : rawBody, "utf8");
        const responseHeaders = stripProxyResponseHeaders(upstream.headers);
        if (translatedBody) responseHeaders["content-type"] = "application/json";
        responseHeaders["content-length"] = String(responseBody.length);
        res.writeHead(upstream.status, responseHeaders);
        res.end(responseBody);
        return;
      }
      res.writeHead(upstream.status, stripProxyResponseHeaders(upstream.headers));
      const contentEncoding = String(upstream.headers.get("content-encoding") || "").toLowerCase();
      let responseStream = Readable.fromWeb(upstream.body).on("error", () => res.destroy());
      if (contentEncoding === "gzip" || contentEncoding === "x-gzip") {
        responseStream = responseStream.pipe(zlib.createGunzip());
      } else if (contentEncoding === "deflate") {
        responseStream = responseStream.pipe(zlib.createInflate());
      } else if (contentEncoding === "br") {
        responseStream = responseStream.pipe(zlib.createBrotliDecompress());
      }
      const shouldTransformOpenAiResponse = claudeResponsesBridge?.kind !== "responses"
        && !target.chatgpt
        && (isCompactProxyTarget(target) || isResponsesProxyTarget(target));
      const diagnostics = !target.chatgpt && isResponsesProxyTarget(target)
        ? createStreamDiagnostics(target, req.url)
        : null;
      let diagnosticsFinished = false;
      const finishDiagnostics = (reason) => {
        if (!diagnostics || diagnosticsFinished) return;
        diagnosticsFinished = true;
        diagnostics.finish(reason);
      };
      responseStream.on("error", () => finishDiagnostics("source_error"));
      if (claudeResponsesBridge?.kind === "responses" && contentType.includes("event-stream")) {
        responseStream = responseStream.pipe(createClaudeResponsesSseTransformStream(
          claudeResponsesBridge.originalRequest,
          diagnostics
        ));
      } else if (shouldTransformOpenAiResponse) {
        responseStream = responseStream.pipe(createSseResponseTransformStream(target, contentType.includes("event-stream"), diagnostics));
      }
      responseStream.on("end", () => finishDiagnostics("end"));
      responseStream.on("close", () => finishDiagnostics("close"));
      res.on("close", () => {
        if (!res.writableEnded) finishDiagnostics("client_close");
      });
      res.on("error", () => finishDiagnostics("response_error"));
      responseStream.pipe(res);
    } catch (error) {
      console.error(`[Proxy Error] ${req.url} failed:`, error);
      writeProxyError(res, 502, `Provider proxy request failed: ${error?.message || error}`);
    }
  }

  function startProviderProxyServer() {
    const server = http.createServer((req, res) => {
      handleProviderProxyRequest(req, res).catch((error) => {
        writeProxyError(res, 500, `Provider proxy crashed: ${error?.message || error}`);
      });
    });
    server.on("upgrade", (req, socket, head) => {
      if (providerProxyRestartRequested) {
        writeProxySocketError(socket, 503, "Provider proxy is restarting; retry after it becomes healthy.");
        return;
      }
      trackProviderProxyUpgrade(socket);
      handleProviderProxyUpgrade(req, socket, head).catch((error) => {
        writeProxySocketError(socket, 500, `Provider proxy crashed: ${error?.message || error}`);
      });
    });
    server.listen(providerProxyPort, providerProxyHost, () => {
      providerProxyServer = server;
      providerProxyStartedAtMs = Date.now();
      providerProxyRestartRequested = false;
      providerProxyRestartClosing = false;
      providerProxyActiveRequests = 0;
      providerProxyActiveUpgrades = 0;
      process.stdout.write(`codex-auth-advanced provider proxy listening on http://${providerProxyHost}:${providerProxyPort}\n`);
    });
    server.on("error", (error) => {
      if (providerProxyServer === server) providerProxyServer = null;
      if (error?.code === "EADDRINUSE") {
        process.stderr.write(`Provider proxy port ${providerProxyPort} is already in use.\n`);
      } else {
        process.stderr.write(`Provider proxy failed: ${error?.message || error}\n`);
      }
      process.exit(1);
    });
  }

  async function providerProxyIsRunning() {
    try {
      const response = await fetch(providerProxyHealthUrl(), { signal: AbortSignal.timeout(700) });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  function detachedProxyEnv() {
    return {
      ...process.env,
      CODEX_AUTH_ADVANCED_NODE_EXECUTABLE: process.execPath,
      CODEX_AUTH_ADVANCED_PROVIDER_PROXY_CHILD: "1"
    };
  }

  async function ensureProviderProxyRunning({ quiet = false } = {}) {
    if (await providerProxyIsRunning()) return true;
    const logDir = path.join(userHome(), "codex-auth-advanced");
    const logFile = path.join(logDir, "proxy.log");
    ensureDir(logDir);
    const outFd = fs.openSync(logFile, "a");
    const scriptPath = providerProxyScriptPath;
    const child = spawn(process.execPath, [scriptPath, "proxy", "serve"], {
      detached: true,
      stdio: ["ignore", outFd, outFd],
      env: detachedProxyEnv()
    });
    child.unref();
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (await providerProxyIsRunning()) {
        if (!quiet) process.stdout.write(`Started codex-auth-advanced provider proxy at http://${providerProxyHost}:${providerProxyPort}.\n`);
        return true;
      }
    }
    if (!quiet) process.stderr.write(`Warning: provider proxy did not respond at ${providerProxyHealthUrl()}.\n`);
    return false;
  }

  return {
    groupId: providerProxyGroupId,
    baseUrl: providerProxyBaseUrl,
    accountBaseUrl: providerProxyAccountBaseUrl,
    healthUrl: providerProxyHealthUrl,
    isBaseUrl: isProviderProxyBaseUrl,
    proxyRequestTargetUrl,
    routeFromIncoming: providerProxyRouteFromIncoming,
    sanitizeRequestHeaders: sanitizeProxyRequestHeaders,
    startServer: startProviderProxyServer,
    isRunning: providerProxyIsRunning,
    ensureRunning: ensureProviderProxyRunning
  };
}
