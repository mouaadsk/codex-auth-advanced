// WebSocket upgrade handler for the provider proxy. It tunnels HTTPS/HTTP
// upgrade requests through to the chatgpt upstream (the only account type
// that supports WebSocket transport) and captures any Cloudflare cookies
// the upstream returns for future requests.

import http from "node:http";
import https from "node:https";
import {
  sanitizeProxyRequestHeaders,
  writeProxySocketError,
  writeProxySocketResponseHead,
  bindProxySocketTunnel
} from "./provider-proxy-http.mjs";

/**
 * Tunnel a WebSocket upgrade to the upstream chatgpt target.
 *
 * @param {object} ctx
 * @param {http.IncomingMessage} ctx.req
 * @param {net.Socket} ctx.socket
 * @param {Buffer} ctx.head
 * @param {object} ctx.target - resolved upstream target
 * @param {object} ctx.route - parsed route (codexHome, accountSelector, pathPrefix)
 * @param {(headers: object) => void} ctx.captureChatgptCloudflareCookies
 */
export async function handleProviderProxyUpgrade({ req, socket, head, target, route, captureChatgptCloudflareCookies }) {
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
      if (target.chatgpt) captureChatgptCloudflareCookies(upstreamRes.headers);
      writeProxySocketResponseHead(socket, upstreamRes.statusCode || 101, upstreamRes.headers, { allowUpgrade: true });
      if (upstreamHead?.length) socket.write(upstreamHead);
      if (head?.length) upstreamSocket.write(head);
      bindProxySocketTunnel(socket, upstreamSocket);
    });

    upstreamRequest.on("response", (upstreamRes) => {
      if (target.chatgpt) captureChatgptCloudflareCookies(upstreamRes.headers);
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
