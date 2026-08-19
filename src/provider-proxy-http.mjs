// Pure HTTP / header utilities for the provider proxy. None of these
// helpers touch the proxy closure state, so they live outside
// createProviderProxy.

import http from "node:http";

export function isProviderProxyLoopbackRequest(req) {
    const address = String(req.socket?.remoteAddress || "");
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  }


export function writeProviderProxyControlResponse(res, status, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      ...extraHeaders
    });
    res.end(body);
  }


export function stripHopByHopHeaders(headers) {
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


export function stripProxyResponseHeaders(headers) {
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


export function isAllowedCloudflareCookieName(name) {
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


export function cookieNameFromSetCookie(header) {
    const name = String(header || "").split("=", 1)[0]?.trim();
    return name || null;
  }


export function responseSetCookieHeaders(headers) {
    if (!headers) return [];
    if (typeof headers.getSetCookie === "function") {
      return headers.getSetCookie();
    }
    const setCookie = headers["set-cookie"] ?? headers["Set-Cookie"];
    if (Array.isArray(setCookie)) return setCookie;
    if (typeof setCookie === "string" && setCookie.length > 0) return [setCookie];
    return [];
  }


export function writeProxyError(res, status, message) {
    if (res.destroyed || res.writableEnded) return false;
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        // The response is already closing; avoid a second writeHead attempt.
      }
      return false;
    }
    const body = JSON.stringify({ error: { message, type: "codex_auth_advanced_proxy" } });
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body)
    });
    res.end(body);
    return true;
  }


export function writeProxySocketError(socket, status, message) {
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


export function writeProxySocketResponseHead(socket, status, headers, { allowUpgrade = false } = {}) {
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


export function bindProxySocketTunnel(clientSocket, upstreamSocket) {
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



// Sanitize proxy request headers for forwarding to an upstream target.
//
// Strips hop-by-hop headers, removes caller credentials, and injects the
// stored API key or access token for the active account. The optional
// `cloudflareCookieHeader` is appended to the Cookie header for chatgpt
// targets so Cloudflare challenge cookies survive the round-trip.
export function sanitizeProxyRequestHeaders(headers, target, { websocket = false, omitContentEncoding = false, cloudflareCookieHeader = null } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "content-length") continue;
    if (omitContentEncoding && lower === "content-encoding") continue;
    if (lower === "proxy-authenticate" || lower === "proxy-authorization" || lower === "proxy-connection" || lower === "te" || lower === "trailer" || lower === "transfer-encoding") continue;
    if (!websocket && (lower === "connection" || lower === "upgrade")) continue;
    if (lower === "accept-encoding" && websocket) continue;
    if (target.officialAnthropic) {
      if (lower === "cookie" || lower === "x-authorization" || lower === "referer" || lower === "origin" || lower.startsWith("oai-") || (!websocket && lower.startsWith("sec-"))) continue;
    } else if (!target.chatgpt) {
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

  if (!target.chatgpt && !target.officialAnthropic) {
    out.authorization = `Bearer ${target.apiKey}`;
  } else if (target.accessToken) {
    out.authorization = `Bearer ${target.accessToken}`;
  }

  if (target.chatgpt && cloudflareCookieHeader) {
    const existingCookie = out.cookie ? `${out.cookie}; ` : "";
    out.cookie = `${existingCookie}${cloudflareCookieHeader}`;
  }

  out["user-agent"] = out["user-agent"] || "codex-auth-advanced-proxy";
  return out;
}
