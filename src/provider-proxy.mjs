import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { readClonedResponseBody } from "./provider-client.mjs";
import {
  claudeGatewayModelsResponse,
  isClaudeGatewayModelsRequest,
  isVsllmClaudeGatewayModel
} from "./claude-gateway.mjs";
import {
  createClaudeResponsesSseTransformStream
} from "./claude-responses-sse.mjs";
import {
  prepareClaudeResponsesBridge,
  retargetClaudeResponsesBridge
} from "./claude-responses-core.mjs";
import { translateResponsesResponseToClaude, prepareClaudeChatBridge } from "./claude-responses-responses.mjs";
import { prepareChatResponsesBridge, translateResponsesResponseToChat, chatTargetFromResponsesTarget } from "./chat-responses-core.mjs";
import {
  apiProviderExhaustionReason,
  detectSourceShapeFromUrl,
  apiProviderTransientRetryReason,
  isInvalidEncryptedContentBody,
  WIRE_SHAPES
} from "./provider-policy.mjs";
import {
  createSseResponseTransformStream,
  createStreamDiagnostics,
  inspectSsePreludeForModelCapacity
} from "./proxy-sse-transforms.mjs";
import { isResponsesProxyTarget } from "./proxy-sse-transforms.mjs";
import { rewriteProviderProxyRequestBody } from "./proxy-body-transforms.mjs";
import {
  isClaudeMessagesCompactionTarget,
  isCompactProxyTarget,
  isRetryableCompactionStatus,
  isUnsupportedVsllmReasoningLevelResponse,
  repairProviderProxyBodyPlaintext,
  retryableVsllmReasoningEffort,
  vsllmReasoningLevelMaxRetries,
  vsllmReasoningLevelRetryDelayMs
} from "./proxy-compaction.mjs";
import {
  describeCompactionFailure,
  runLocalCompactionFallback,
  runLocalCompactionFallbackAcrossAccounts,
  summarizeViaShape
} from "./proxy-compaction.mjs";
// antigravity translations are handled inside shape-translator.mjs
// (buildShapeBridge + retargetBridge + translateShapeResponse).
import {
  buildShapeBridge,
  retargetBridge,
  translateRequest as translateShapeRequest,
  translateResponse as translateShapeResponse,
  createShapeSseTransformStream
} from "./shape-translator.mjs";
import {
  isProviderProxyLoopbackRequest,
  writeProviderProxyControlResponse,
  stripHopByHopHeaders,
  stripProxyResponseHeaders,
  isAllowedCloudflareCookieName,
  cookieNameFromSetCookie,
  responseSetCookieHeaders,
  writeProxyError,
  writeProxySocketError,
  writeProxySocketResponseHead,
  bindProxySocketTunnel,
  sanitizeProxyRequestHeaders as _sanitizeProxyRequestHeaders
} from "./provider-proxy-http.mjs";
import {
  providerProxyGroupId,
  codexHomeFromProviderProxyGroupId,
  providerProxyBaseUrl,
  providerProxyAccountBaseUrl,
  providerProxyHealthUrl,
  isProviderProxyBaseUrl,
  isTransientApiFailureStatus,
  proxyRequestTargetUrl,
  isClaudeMessagesTarget,
  isOfficialClaudeModel,
  providerProxyRouteFromIncoming,
  shapeUrlFor
} from "./provider-proxy-routing.mjs";
import { createEndpointChainPlanner, shapeName } from "./endpoint-chain.mjs";
import { probeModelShapes } from "./shape-probe.mjs";
import { loadShapeCapabilityCache, upsertShapeCapability } from "./shape-probe-store.mjs";
import { kickOffShapeProbe, providerSlugForTarget, recordShapeProbeResult, supportedShapesForModelWithProbe } from "./provider-policy.mjs";
import { handleProviderProxyUpgrade } from "./provider-proxy-upgrade.mjs";
import { ensureDir, userHome } from "./storage.mjs";

const providerProxyScriptPath = fileURLToPath(new URL("../bin/codex-auth-advanced.js", import.meta.url));
const upstreamHeaderStallErrorCode = "CODEX_AUTH_ADVANCED_UPSTREAM_HEADER_STALL";
const maxModelCapacityRetryDelayMs = 60_000;

function retryAfterDelayMs(response) {
  const raw = response?.headers?.get?.("retry-after");
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value) return null;

  // RFC 7231 permits either a delay in seconds or an HTTP date. Keep a
  // provider-supplied delay bounded so a malformed/hostile gateway header
  // cannot hold a Codex request indefinitely.
  let delay = null;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    delay = Number(value) * 1000;
  } else {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) delay = timestamp - Date.now();
  }
  if (!Number.isFinite(delay)) return null;
  return Math.max(0, Math.min(maxModelCapacityRetryDelayMs, Math.ceil(delay)));
}

export function modelCapacityRetryDelay(response, retryNumber, baseDelayMs) {
  const providerDelay = retryAfterDelayMs(response);
  if (providerDelay != null) return providerDelay;

  const exponential = Math.max(0, Number(baseDelayMs) || 0) * (2 ** Math.max(0, retryNumber));
  const bounded = Math.min(maxModelCapacityRetryDelayMs, exponential);
  if (bounded <= 0) return 0;

  // Add a small positive jitter to avoid several clients retrying the same
  // overloaded channel in lockstep. The cap keeps the delay predictable.
  const jitterMax = Math.min(1000, Math.max(1, Math.ceil(bounded * 0.25)));
  return Math.min(maxModelCapacityRetryDelayMs, bounded + Math.floor(Math.random() * (jitterMax + 1)));
}

// Extract session-correlation fields from a Codex CLI request so log lines
// can be tied back to a specific /Users/mouaad-mac/.codex/sessions/<date>/rollout-<id>.jsonl.
//
// Codex CLI does NOT send an x-codex-session-id header. The session id only
// appears in the local JSONL filename. The body, however, carries the turn
// id in input[*].internal_chat_message_metadata_passthrough.turn_id, and
// the workspace cwd is encoded in the URL path (decoded into route.codexHome
// by providerProxyRouteFromIncoming). Together those let an investigator
// find the matching rollout file via:
//   ~/.codex/sessions/<year>/<month>/<day>/rollout-<id>.jsonl
//
// Returns { codexHome, sessionId, turnId }. Never throws — invalid bodies
// just yield nulls so log enrichment stays best-effort and never blocks a
// real upstream call.
export function extractCodexRequestCorrelation(body, route) {
  const codexHome = typeof route?.codexHome === "string" ? route.codexHome : null;
  const sessionId = null; // Codex CLI does not transmit this.
  let turnId = null;
  if (body == null) return { codexHome, sessionId, turnId };
  try {
    const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
    if (!text) return { codexHome, sessionId, turnId };
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.input)) {
      // Walk in reverse so the most recent turn id wins (assistant turns
      // typically sit at the tail of input[]).
      for (let i = parsed.input.length - 1; i >= 0; i -= 1) {
        const meta = parsed.input[i]?.internal_chat_message_metadata_passthrough;
        const candidate = typeof meta?.turn_id === "string" ? meta.turn_id : null;
        if (candidate) {
          turnId = candidate;
          break;
        }
      }
    }
  } catch {
    // Body is not JSON (e.g. non-decoded upstream request body) — leave
    // turnId null. This is best-effort logging, not a parsing contract.
  }
  return { codexHome, sessionId, turnId };
}

// Build the suffix appended to proxy log lines so operators can grep by
// session/turn. Format is stable and easy to parse:
//   " codex_home=/Users/mouaad-mac/.codex turn=<id>"
// When turnId is missing, only the codex_home is appended (still useful for
// multi-codex-home setups).
export function codexCorrelationLogSuffix(correlation) {
  if (!correlation) return "";
  const parts = [];
  if (correlation.codexHome) parts.push(`codex_home=${correlation.codexHome}`);
  if (correlation.turnId) parts.push(`turn=${correlation.turnId}`);
  if (correlation.sessionId) parts.push(`session=${correlation.sessionId}`);
  return parts.length ? ` | ${parts.join(" ")}` : "";
}

export function createProviderProxy(options) {
  const providerProxyHost = options.host;
  const providerProxyPort = options.port;
  const providerProxyPrefix = options.prefix;
  const activeApiProxyTarget = options.activeApiProxyTarget;
  const pinnedApiProxyTarget = options.pinnedApiProxyTarget;
  const markApiAccountExhaustedFromProxy = options.markApiAccountExhaustedFromProxy;
  const switchFromExhaustedApiAccount = options.switchFromExhaustedApiAccount;
  const targetFromTransientApiFailure = options.targetFromTransientApiFailure;
  const listCompactionAccountCandidates = options.listCompactionAccountCandidates;
  const vsllmTransientUsageLimitMaxRetries = options.vsllmTransientUsageLimitMaxRetries;
  const vsllmTransientUsageLimitRetryDelayMs = options.vsllmTransientUsageLimitRetryDelayMs;
  const modelCapacityMaxRetries = options.modelCapacityMaxRetries;
  const modelCapacityRetryBaseDelayMs = options.modelCapacityRetryBaseDelayMs;
  const modelCapacityStreamProbeMs = Math.max(0, Number(options.modelCapacityStreamProbeMs) || 0);
  // Watchdog for silent origins (e.g. VSLLM models that accept a request then
  // stream nothing — not even PING keep-alives). If an SSE stream produces no
  // upstream bytes for this long, we terminate it with an SSE error event so
  // clients fail fast instead of hanging for minutes. Chunks we synthesize
  // locally (e.g. SSE transform heartbeats) do NOT reset the timer — only real
  // upstream bytes prove the origin is alive.
  const streamStallWatchdogMs = Math.max(0, Number(options.streamStallWatchdogMs) || 0);
  const officialAnthropicBaseUrl = String(options.officialAnthropicBaseUrl || "https://api.anthropic.com").replace(/\/+$/, "");

  const chatgptCloudflareCookies = new Map();  function captureChatgptCloudflareCookies(headers) {
    for (const header of responseSetCookieHeaders(headers)) {
      const name = cookieNameFromSetCookie(header);
      if (!name || !isAllowedCloudflareCookieName(name)) continue;
      const value = String(header).split(";", 1)[0]?.trim();
      if (value) chatgptCloudflareCookies.set(name, value);
    }
  }

  const claudeGatewayCatalogCache = new Map();
  const claudeGatewayCatalogCacheTtlMs = 5 * 60 * 1000;
  try {
    const persisted = loadShapeCapabilityCache();
    if (persisted && persisted.providers) {
      for (const [providerSlug, models] of Object.entries(persisted.providers)) {
        for (const [modelId, entry] of Object.entries(models || {})) {
          if (!entry || !Array.isArray(entry.shapes) || !entry.shapes.length) continue;
          recordShapeProbeResult(providerSlug, modelId, entry.shapes);
        }
      }
    }
  } catch (err) {
    process.stderr.write(`codex-auth-advanced: failed to preload shape capability cache: ${err?.message || err}\n`);
  }
  let providerProxyServer = null;
  let providerProxyStartedAtMs = null;
  let providerProxyRestartRequested = false;
  let providerProxyRestartClosing = false;
  let providerProxyActiveRequests = 0;
  let providerProxyActiveUpgrades = 0;






  function providerProxyActiveOperationCount() {
    return providerProxyActiveRequests + providerProxyActiveUpgrades;
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




  function targetUrlForProxyRequest(req, route) {
    const target = route.accountSelector
      ? pinnedApiProxyTarget(route.codexHome, route.accountSelector)
      : activeApiProxyTarget(route.codexHome);
    if (target.error) return target;
    return proxyRequestTargetUrl(req, route.codexHome, target, route.pathPrefix, providerProxyHost, providerProxyPort);
  }

  function officialAnthropicTargetForProxyRequest(req, route) {
    return proxyRequestTargetUrl(req, route.codexHome, {
      upstreamBaseUrl: officialAnthropicBaseUrl,
      officialAnthropic: true
    }, route.pathPrefix, providerProxyHost, providerProxyPort);
  }



  async function modelsFromProvider(req, target) {
    try {
      const response = await fetchProviderTarget(req, target, undefined, { timeout: 5000 });
      if (!response.ok) return null;
      const body = await response.json();
      return Array.isArray(body?.data) ? body.data : null;
    } catch {
      return null;
    }
  }

  async function claudeGatewayCatalogForRequest(req, target, route) {
    const cacheKey = target.account?.account_key || target.upstreamBaseUrl || target.url;
    const cached = claudeGatewayCatalogCache.get(cacheKey);
    if (cached?.complete && Date.now() - cached.createdAtMs < claudeGatewayCatalogCacheTtlMs) {
      return cached.catalog;
    }

    const officialTarget = officialAnthropicTargetForProxyRequest(req, route);
    const [vsllmModels, officialModels] = await Promise.all([
      modelsFromProvider(req, target),
      modelsFromProvider(req, officialTarget)
    ]);
    const catalog = claudeGatewayModelsResponse({
      vsllmModels: vsllmModels ?? cached?.vsllmModels ?? [],
      officialModels: officialModels ?? cached?.officialModels ?? []
    });
    if (vsllmModels != null || officialModels != null) {
      claudeGatewayCatalogCache.set(cacheKey, {
        createdAtMs: Date.now(),
        complete: vsllmModels != null && officialModels != null,
        catalog,
        vsllmModels: vsllmModels ?? cached?.vsllmModels ?? [],
        officialModels: officialModels ?? cached?.officialModels ?? []
      });
    }
    return catalog;
  }







  function chatgptCloudflareCookieHeader() {
    return [...chatgptCloudflareCookies.values()].join("; ");
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
    const timeoutSignal = Number.isFinite(timeoutMs)
      && timeoutMs > 0
      && typeof AbortSignal !== "undefined"
      && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : null;
    const headerStallController = options.streaming === true && streamStallWatchdogMs > 0
      ? new AbortController()
      : null;
    let headerStallTriggered = false;
    let headerStallTimer = null;
    if (headerStallController) {
      headerStallTimer = setTimeout(() => {
        headerStallTriggered = true;
        headerStallController.abort();
      }, streamStallWatchdogMs);
      headerStallTimer.unref?.();
    }
    const signals = [timeoutSignal, headerStallController?.signal].filter(Boolean);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const headers = sanitizeProxyRequestHeaders(req.headers, target, {
      omitContentEncoding: options.omitContentEncoding === true
    });
    if (body != null) {
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    try {
      return await fetch(target.url, {
        method: req.method,
        headers,
        body,
        duplex: body == null ? undefined : "half",
        signal
      });
    } catch (error) {
      if (headerStallTriggered) {
        const stallError = new Error(`Upstream sent no response headers for ${streamStallWatchdogMs}ms.`);
        stallError.code = upstreamHeaderStallErrorCode;
        stallError.cause = error;
        throw stallError;
      }
      throw error;
    } finally {
      if (headerStallTimer) clearTimeout(headerStallTimer);
    }
  }

  function upstreamHeaderStallResponse(target) {
    const label = target.account?.alias || target.account?.email || target.account?.account_key || "provider";
    const body = JSON.stringify({
      error: {
        message: `[codex-auth-advanced] Upstream ${label} stalled: no response headers for ${streamStallWatchdogMs}ms. Failing over or returning promptly instead of hanging.`,
        type: "codex_auth_advanced_stream_stall"
      }
    });
    return new Response(body, {
      status: 524,
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body))
      }
    });
  }

  function upstreamFetchFailureResponse(target, error) {
    const label = target.account?.alias || target.account?.email || target.account?.account_key || "provider";
    const detail = error?.cause?.code || error?.code || error?.message || String(error);
    const body = JSON.stringify({
      error: {
        message: `[codex-auth-advanced] Upstream request to ${label} failed before a response (${detail}).`,
        type: "codex_auth_advanced_upstream_fetch"
      }
    });
    return new Response(body, {
      status: 502,
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body))
      }
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

    const route = providerProxyRouteFromIncoming(incoming, providerProxyPrefix);
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
        const catalog = await claudeGatewayCatalogForRequest(req, target, route);
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(catalog)
        });
        res.end(catalog);
        return;
      }
      let body = await readProxyRequestBody(req);
      let upstream = null;
      // Compute Codex session correlation once per request so the [Proxy Request]
      // log line can be tied back to ~/.codex/sessions/.../rollout-<id>.jsonl.
      // Best-effort: helpers never throw on malformed bodies.
      const codexCorrelation = extractCodexRequestCorrelation(body, route);
      const codexCorrelationSuffix = codexCorrelationLogSuffix(codexCorrelation);
      const originalSourceBody = body;
      const attemptedAccountKeys = new Set();
      const transientUsageLimitRetries = new Map();
      const modelCapacityRetries = new Map();
      const reasoningLevelRetries = new Map();
      const modelCapacityRetryKey = (currentTarget) => [
        currentTarget.account?.account_key || currentTarget.account?.alias || currentTarget.url,
        currentTarget.url
      ].join("\u0000");
      let bodyAlreadyDecoded = false;
      let triedEncryptedContentRepair = false;
      let claudeResponsesBridge = null;
      let claudeMessagesCompaction = false;
      let claudeCompactionModel = null;
      let originalRequestModel = null;
      const rewrittenBody = rewriteProviderProxyRequestBody(target, body, req.headers);
      originalRequestModel = rewrittenBody.originalModel;
      const remoteCompactionV2 = rewrittenBody.remoteCompactionV2 === true;
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
      // The bridge only applies to VSLLM targets, so prepare it before any
      // switch to the official Anthropic OAuth target below; an official
      // target can never match the bridge's VSLLM guard.
      claudeResponsesBridge = prepareClaudeResponsesBridge(target, body);
      // LLMAPI documents Claude Code support at /v1/messages, so a Claude
      // model on an llmapi account is supposed to be served by llmapi, not
      // by the official Anthropic OAuth target. The official Anthropic path
      // is reserved for users who have actually configured an Anthropic
      // OAuth account — when the active account is llmapi (or any other
      // provider that supports Anthropic Messages), keep the configured
      // target so the request reaches the right upstream.
      const accountSupportsClaudeMessages = target?.account?.api_template === "llmapi"
        || /llmapi/i.test(String(target?.account?.alias || "") + String(target?.account?.email || ""));
      if (isClaudeMessagesTarget(target)
        && isOfficialClaudeModel(rewrittenBody.originalModel)
        && !accountSupportsClaudeMessages) {
        target = officialAnthropicTargetForProxyRequest(req, route);
      } else if (!target.chatgpt && !target.officialAnthropic && claudeResponsesBridge?.kind !== "responses") {
        // Claude Code /compact is a plain /v1/messages request; detect it by
        // content so a hung upstream can degrade to a local summary instead
        // of surfacing a raw 524.
        try {
          const parsedBody = JSON.parse(body.toString("utf8"));
          claudeMessagesCompaction = isClaudeMessagesCompactionTarget(target, parsedBody);
          claudeCompactionModel = typeof parsedBody?.model === "string" ? parsedBody.model : null;
        } catch {
          claudeMessagesCompaction = false;
        }
      }
      if (claudeResponsesBridge?.kind === "count_tokens") {
        const responseBody = Buffer.from(JSON.stringify({ input_tokens: claudeResponsesBridge.inputTokens }), "utf8");
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": responseBody.length
        });
        res.end(responseBody);
        return;
      }
      const requestIsStreaming = (() => {
        if (!body) return false;
        try {
          const parsed = bodyAlreadyDecoded
            ? (Buffer.isBuffer(body) ? JSON.parse(body.toString("utf8")) : body)
            : JSON.parse(body.toString("utf8"));
          return parsed?.stream === true;
        } catch {
          return false;
        }
      })();
      if (claudeResponsesBridge?.kind === "responses") {
        target = claudeResponsesBridge.target;
        body = claudeResponsesBridge.body;
        bodyAlreadyDecoded = true;
        console.log(`[Proxy] Bridging Claude Messages model ${claudeResponsesBridge.originalRequest.model} through OpenAI Responses.`);
      }
      // Universal endpoint chain: detect the wire shape the client sent and
      // walk per-account shape plans on transport failures before considering
      // an account-level switch. Account switching still happens on balance
      // exhaustion only; shape failover stays on the same account.
      const sourceShape = detectSourceShapeFromUrl(incoming.pathname);
      const planner = createEndpointChainPlanner({
        sourceShape,
        isCompact: isCompactProxyTarget(target),
        requestUrl: req.url,
        model: originalRequestModel
      });
      planner.prime(target.account);
      const isCompact = isCompactProxyTarget(target);
      // Background-probe per-model shape capabilities when we have not seen
      // this model before on this account. Hard-coded MODEL_SHAPE_CAPABILITIES
      // and prior probe results short-circuit this; for unknown models we
      // kick off a one-shot probe so the next request lands on the right
      // shape without waiting on a chain-walk to discover it.
      if (originalRequestModel && target.account
        && process.env.CODEX_AUTH_ADVANCED_DISABLE_SHAPE_PROBE !== "1") {
        const providerSlug = providerSlugForTarget(target, target.account);
        const known = supportedShapesForModelWithProbe(originalRequestModel, providerSlug);
        if (!known) {
          const probeAccount = target.account;
          const probeTarget = { upstreamBaseUrl: target.upstreamBaseUrl, apiKey: target.apiKey };
          setImmediate(() => {
            kickOffShapeProbe({
              accountKey: providerSlug,
              model: originalRequestModel,
              probeFn: async () => {
                const shapes = await probeModelShapes({
                  account: probeAccount,
                  model: originalRequestModel,
                  target: probeTarget
                });
                if (shapes && shapes.size) {
                  upsertShapeCapability({
                    providerSlug,
                    model: originalRequestModel,
                    supportedShapes: [...shapes]
                  });
                }
                return shapes;
              }
            });
          });
        }
      }

      // Universal shape bridge dispatcher. Given the current target and the
      // next shape to try, translates the request body into that shape's
      // wire format and returns {target, body} for the chain walker to use.
      // Universal shape bridge: delegates to shape-translator.mjs which
      // owns all 4-shape request/response translation. The proxy only
      // owns the chain walker and the account-switch logic.
      function prepareShapeBridge({ target: curTarget, nextShape, sourceShape: srcShape, sourceBody, originalRequest: origReq }) {
        return buildShapeBridge({
          target: curTarget,
          sourceShape: srcShape,
          targetShape: nextShape,
          sourceBody,
          sourceRequest: origReq
        });
      }

      function translateShapeResponseToSource({ rawBody, fromShape, toShape, bridge }) {
        return translateShapeResponse(fromShape, toShape, rawBody, bridge?.originalRequest || {});
      }

      while (true) {
        let streamTransientRetryReason = null;
        if (target.account?.account_key) attemptedAccountKeys.add(target.account.account_key);
        const targetLabel = target.officialAnthropic
          ? "official Anthropic OAuth"
          : target.account?.alias
            ? `account ${target.account.alias}`
            : target.chatgpt
              ? "ChatGPT account"
              : "API provider";
        console.log(`[Proxy Request] ${req.method} ${req.url} -> ${targetLabel}: ${target.url}${codexCorrelationSuffix}`);

        if (remoteCompactionV2
          && !target.chatgpt
          && !target.officialAnthropic
          && claudeResponsesBridge?.kind !== "responses") {
          console.log("[Proxy] Codex remote compaction v2 detected; generating a provider-compatible local summary.");
          let localCompacted = await runLocalCompactionFallbackAcrossAccounts(
            target,
            body,
            req.headers,
            bodyAlreadyDecoded,
            sanitizeProxyRequestHeaders,
            {
              originalModel: originalRequestModel,
              remoteCompactionV2: true,
              codexHome: route.codexHome,
              pinnedOnly: !!route.accountSelector,
              listCompactionAccountCandidates
            }
          );
          if (!localCompacted) {
            const reason = describeCompactionFailure(target);
            console.warn(`[Proxy] Remote compaction v2 fallback failed: ${reason}; leaving the original request intact.`);
            return writeProxyError(res, 502, `Provider-compatible summarization failed: ${reason}; compaction was not applied.`);
          }
          upstream = localCompacted;
          break;
        }

        let fetchFailed = false;
        let fetchError = null;
        try {
          upstream = await fetchProviderTarget(req, target, body, {
            omitContentEncoding: bodyAlreadyDecoded,
            timeout: (isCompactProxyTarget(target) && !target.chatgpt) ? 15000 : undefined,
            streaming: requestIsStreaming
          });
        } catch (err) {
          fetchError = err;
          if (err?.code === upstreamHeaderStallErrorCode) {
            console.warn(`[Proxy Stream] ${req.url} stalled before upstream headers on ${targetLabel}; treating it as a transient 524.${codexCorrelationSuffix}`);
            upstream = upstreamHeaderStallResponse(target);
          } else if (!target.chatgpt && !target.officialAnthropic) {
            console.warn(`[Proxy] ${req.url} failed before upstream headers on ${targetLabel}; treating it as a transient 502 (${err?.cause?.code || err?.code || err?.message || err}).${codexCorrelationSuffix}`);
            upstream = upstreamFetchFailureResponse(target, err);
          } else {
            fetchFailed = true;
          }
        }

        if ((target.chatgpt || target.officialAnthropic) && !fetchFailed) {
          captureChatgptCloudflareCookies(upstream.headers);
          break;
        }

        if (!fetchFailed && requestIsStreaming && modelCapacityStreamProbeMs > 0) {
          const inspected = await inspectSsePreludeForModelCapacity(upstream, {
            // Never let the capacity prelude outlive the existing silent-stream
            // watchdog. Otherwise a provider that sends headers and then goes
            // completely quiet would be delayed by two independent timers.
            timeoutMs: streamStallWatchdogMs > 0
              ? Math.min(modelCapacityStreamProbeMs, streamStallWatchdogMs)
              : modelCapacityStreamProbeMs
          });
          upstream = inspected.response;
          if (inspected.modelCapacity) {
            const retryKey = modelCapacityRetryKey(target);
            const retries = modelCapacityRetries.get(retryKey) || 0;
            if (retries < modelCapacityMaxRetries) {
              modelCapacityRetries.set(retryKey, retries + 1);
              const delayMs = modelCapacityRetryDelay(upstream, retries, modelCapacityRetryBaseDelayMs);
              const label = target.account?.alias || target.account?.email || target.account?.account_key || "provider";
              console.warn(
                `[Proxy Stream] ${label} reported model capacity before output; retrying the exact same request in ${delayMs}ms (${retries + 1}/${modelCapacityMaxRetries}).`
              );
              try { await upstream.body?.cancel(); } catch {}
              await new Promise((resolve) => setTimeout(resolve, delayMs));
              continue;
            }
            const label = target.account?.alias || target.account?.email || target.account?.account_key || "provider";
            console.warn(
              `[Proxy Stream] ${label} still reported model capacity after ${modelCapacityMaxRetries} retries; forwarding the terminal stream error without replaying partial output.`
            );
            // Keep the normal transient-failure path below active. It may try
            // another usable account for a default route, while pinned routes
            // remain on this exact stream and simply forward the terminal
            // provider event after the bounded same-account budget.
            streamTransientRetryReason = "model_capacity";
          }
        }

        if (isCompactProxyTarget(target) && (fetchFailed
          || isRetryableCompactionStatus(upstream?.status)
          || [404, 405, 524].includes(upstream?.status))) {
          console.log(`[Proxy] Compaction failed or timed out (fetchFailed: ${fetchFailed}, status: ${upstream?.status}, error: ${fetchError?.message}). Triggering local compaction fallback...`);
          let localCompacted = await runLocalCompactionFallbackAcrossAccounts(
            target,
            body,
            req.headers,
            bodyAlreadyDecoded,
            sanitizeProxyRequestHeaders,
            {
              originalModel: originalRequestModel,
              codexHome: route.codexHome,
              pinnedOnly: !!route.accountSelector,
              listCompactionAccountCandidates
            }
          );
          if (!localCompacted) {
            const reason = describeCompactionFailure(target);
            console.warn(`[Proxy] Local compaction fallback failed during error handler: ${reason}; leaving the original request intact.`);
            return writeProxyError(res, 502, `Compaction summarization failed: ${reason}; compaction was not applied.`);
          }
          if (localCompacted) {
            upstream = localCompacted;
            break;
          }
        }

        if (claudeMessagesCompaction && (fetchFailed || [502, 503, 504, 524].includes(upstream.status))) {
          console.log(`[Proxy] Claude compaction request failed or timed out (fetchFailed: ${fetchFailed}, status: ${upstream?.status}, error: ${fetchError?.message}). Triggering local compaction fallback...`);
          let localCompacted = await runLocalCompactionFallbackAcrossAccounts(
            target,
            body,
            req.headers,
            bodyAlreadyDecoded,
            sanitizeProxyRequestHeaders,
            {
              codexHome: route.codexHome,
              pinnedOnly: !!route.accountSelector,
              listCompactionAccountCandidates
            }
          );
          if (!localCompacted) {
            const reason = describeCompactionFailure(target);
            console.warn(`[Proxy] Local Claude compaction fallback failed during error handler: ${reason}; leaving the original request intact.`);
            return writeProxyError(res, 502, `Compaction summarization failed: ${reason}; compaction was not applied.`);
          }
          if (localCompacted) {
            upstream = localCompacted;
            break;
          }
        }

        if (fetchFailed) {
          throw fetchError;
        }

        if (target.repairInvalidEncryptedContent && !triedEncryptedContentRepair) {
          const { invalid } = await invalidEncryptedContentResponse(upstream);
          if (invalid) {
            const stripped = repairProviderProxyBodyPlaintext(target, body, req.headers, {
              alreadyDecoded: bodyAlreadyDecoded
            });
            if (stripped.repaired) {
              const label = target.account?.alias || target.account?.email || target.account?.account_key || "provider";
              const requestKind = isCompactProxyTarget(target) ? "compact request" : "Responses request";
              console.warn(`[Proxy] ${label} rejected encrypted content; retrying the ${requestKind} once without opaque encrypted reasoning state.`);
              try { await upstream.body?.cancel(); } catch {}
              body = stripped.body;
              bodyAlreadyDecoded = bodyAlreadyDecoded || stripped.decoded === true;
              triedEncryptedContentRepair = true;
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
        const effectiveResponseBody = streamTransientRetryReason ? {
          error: {
            code: "server_overloaded",
            message: "Selected model is at capacity. Please try a different model."
          }
        } : responseBody;
        const effectiveTransientRetryReason = streamTransientRetryReason || transientRetryReason;
        const requestedReasoningEffort = retryableVsllmReasoningEffort(target, body);
        if (upstream.status === 400
          && requestedReasoningEffort
          && isUnsupportedVsllmReasoningLevelResponse(effectiveResponseBody, requestedReasoningEffort)) {
          const retryKey = [
            target.account?.account_key || target.account?.alias || target.url,
            target.url,
            requestedReasoningEffort
          ].join("\u0000");
          const retries = reasoningLevelRetries.get(retryKey) || 0;
          if (retries < vsllmReasoningLevelMaxRetries) {
            reasoningLevelRetries.set(retryKey, retries + 1);
            const label = target.account?.alias || target.account?.email || target.account?.account_key || "VSLLM";
            console.warn(
              `[Proxy] ${label} rejected reasoning level ${JSON.stringify(requestedReasoningEffort)}; retrying the same account through the provider channel selector (${retries + 1}/${vsllmReasoningLevelMaxRetries}).`
            );
            try { await upstream.body?.cancel(); } catch {}
            await new Promise((resolve) => setTimeout(resolve, vsllmReasoningLevelRetryDelayMs));
            continue;
          }
        }
        if (effectiveTransientRetryReason === "vsllm_usage_limit") {
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
        if (effectiveTransientRetryReason === "model_capacity") {
          const retryKey = modelCapacityRetryKey(target);
          const retries = modelCapacityRetries.get(retryKey) || 0;
          if (retries < modelCapacityMaxRetries) {
            modelCapacityRetries.set(retryKey, retries + 1);
            const delayMs = modelCapacityRetryDelay(upstream, retries, modelCapacityRetryBaseDelayMs);
            const label = target.account?.alias || target.account?.email || target.account?.account_key || "provider";
            console.warn(`[Proxy] ${label} reported model capacity; retrying the same account in ${delayMs}ms (${retries + 1}/${modelCapacityMaxRetries}).`);
            try { await upstream.body?.cancel(); } catch {}
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }
        }
        if (route.accountSelector && exhausted) {
          markApiAccountExhaustedFromProxy(route.codexHome, target.account, upstream.status, effectiveResponseBody);
        }
        // Per-account wire-shape chain walker: try other supported shapes on
        // the SAME account when the current shape failed with a shape-fallback
        // status (transport error / 4xx/5xx indicating the wrong endpoint).
        // Account switching happens only on balance exhaustion below.
        let shapesForAccount = planner.shapesForAccount(target.account);
        let shapeCursor = shapesForAccount.indexOf(target.responseFromShape || planner.sourceShape);
        if (shapeCursor < 0) shapeCursor = shapesForAccount.indexOf(sourceShape);
        if (shapeCursor < 0) shapeCursor = -1;
        const isShapeFallback = planner.shouldFailOverToNextShape({ status: upstream?.status, body: effectiveResponseBody });
        if (!route.accountSelector && isShapeFallback && shapeCursor + 1 < shapesForAccount.length) {
          const nextShape = shapesForAccount[shapeCursor + 1];
          if (nextShape) {
            const label = target.account?.alias || target.account?.email || target.account?.account_key || "provider";
            console.warn(`[Proxy] ${label} returned status ${upstream?.status}; trying next wire shape ${shapeName(nextShape)}.`);
            // Compact requests need a special summarization call for non-Responses
            // shapes; the upstream does not understand the encrypted_content /
            // compaction_trigger envelope, so summarizeViaShape builds a fresh
            // one-shot prompt and wraps the result back into Codex compact format.
            if (isCompact && nextShape !== WIRE_SHAPES.RESPONSES) {
              const summarized = await summarizeViaShape({
                shape: nextShape,
                target,
                body: originalSourceBody,
                headers: req.headers,
                alreadyDecoded: true,
                sanitizeRequestHeaders: sanitizeProxyRequestHeaders,
                options: { originalModel: originalRequestModel }
              });
              if (summarized) {
                upstream = summarized;
                break;
              }
              // Fall through to advance to next shape on the next iteration.
              continue;
            }
            // Non-compact chain advancement: translate the request body into
            // the next shape's wire format and retarget the URL. The response
            // is translated back to the source shape below.
            const bridge = await prepareShapeBridge({
              target,
              nextShape,
              sourceShape,
              sourceBody: originalSourceBody
            });
            if (bridge) {
              target = bridge.target;
              body = bridge.body;
              bodyAlreadyDecoded = true;
              // SSE translation across shapes is now implemented
              // (createShapeSseTransformStream). Streaming requests stay
              // streaming on the bridged shape; the response path picks
              // the right transform based on responseFromShape /
              // responseToShape.
              target.responseFromShape = nextShape;
              target.responseToShape = sourceShape;
              target.shapeBridge = bridge;
              continue;
            }
            continue;
          }
        }
        // Account-level failover: only on hard exhaustion OR a per-account
        // API-key restriction (the key itself is blocked, not the server).
        // Transport / shape failures stay on the same account (handled by the
        // chain walker above). API-key restriction is transient for the
        // REGISTRY (no persistent switch / no exhaust) but the current
        // request still tries the next account without touching the stored
        // active account. Bounded transient retries (model_capacity / vsllm
        // usage limit) on the SAME account falling through the shape chain
        // also need a transient-only failover to keep the request alive.
        const transientExhausted = (effectiveTransientRetryReason === "model_capacity" || effectiveTransientRetryReason === "vsllm_usage_limit");
        const shouldFailOverAccount = !route.accountSelector
          && (exhausted || transientRetryReason === "api_key_restriction" || transientExhausted);
        if (!shouldFailOverAccount) break;
        let switched = false;
        if (exhausted) {
          switched = await switchFromExhaustedApiAccount(route.codexHome, target.account, upstream.status, effectiveResponseBody, {
            excludeAccountKeys: attemptedAccountKeys,
            force: exhaustionReason === "no_active_subscription" || exhaustionReason === "quota_exhausted" || exhaustionReason === "provider_limit"
          });
        } else {
          // Transient per-key / per-request failover: pick another account
          // for THIS request only; do not mutate the registry's active
          // account or mark any account as exhausted.
          const transientTarget = await targetFromTransientApiFailure(route.codexHome, req, {
            excludeAccountKeys: attemptedAccountKeys
          });
          if (transientTarget) {
            target = retargetClaudeResponsesBridge(transientTarget, claudeResponsesBridge);
            continue;
          }
        }
        if (!switched) break;
        if (!switched) break;
        const newTarget = targetUrlForProxyRequest(req, { ...route, accountSelector: null, pathPrefix: `${providerProxyPrefix}/${providerProxyGroupId(route.codexHome)}` });
        if (!newTarget || newTarget.error || attemptedAccountKeys.has(newTarget.account?.account_key) || newTarget.account?.account_key === target.account?.account_key) break;
        target = retargetClaudeResponsesBridge(newTarget, claudeResponsesBridge);
      }

      console.log(`[Proxy Response] ${req.url} -> status: ${upstream.status}`);
      // Per-shape response translation: when the chain walker retargeted a
      // Responses-source request to /v1/chat/completions or /v1/messages on
      // the same upstream, the response body is in the new shape's format.
      // Translate it back to the source shape so the caller sees what it
      // expected.
      if (target.responseFromShape && target.responseToShape
        && upstream.status >= 200 && upstream.status < 300
        && target.responseFromShape !== target.responseToShape
        && !String(upstream.headers.get("content-type") || "").toLowerCase().includes("event-stream")) {
        try {
          const rawBody = await upstream.text();
          const translated = await translateShapeResponseToSource({
            rawBody,
            fromShape: target.responseFromShape,
            toShape: target.responseToShape,
            sourceBody: originalSourceBody,
            bridge: target.shapeBridge
          });
          if (translated != null) {
            const outBody = Buffer.from(JSON.stringify(translated), "utf8");
            const headers = stripProxyResponseHeaders(upstream.headers);
            headers["content-type"] = "application/json";
            headers["content-length"] = String(outBody.length);
            res.writeHead(upstream.status, headers);
            res.end(outBody);
            return;
          }
        } catch (e) {
          console.warn(`[Proxy] shape response translation failed: ${e?.message || e}`);
        }
      }
      if (!upstream.body) {
        console.log(`[DEBUG streaming] upstream.status=${upstream.status}, content-type=${contentType}, hasBody=${!!upstream.body}`);
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
      // Send headers NOW: while the origin is stalled the piped stream never
      // produces data, and a queued writeHead would sit behind it — along with
      // anything the stall watchdog tries to write later.
      if (contentType.includes("event-stream")) res.flushHeaders();
      const contentEncoding = String(upstream.headers.get("content-encoding") || "").toLowerCase();
      let responseStream = Readable.fromWeb(upstream.body);
      responseStream.on("data", (c) => console.log(`[DEBUG upstream->transform] chunk len=${c.length}, sample=${c.toString().slice(0, 60)}`));
      const watchdogStallTarget = responseStream;
      // The stall watchdog destroys the upstream source when the origin goes
      // silent; that 'error' is expected and must not nuke the client
      // response (the watchdog writes its own terminal SSE event first).
      let stallWatchdogFired = false;
      responseStream.on("error", () => {
        if (!stallWatchdogFired) res.destroy();
      });
      if (contentEncoding === "gzip" || contentEncoding === "x-gzip") {
        responseStream = responseStream.pipe(zlib.createGunzip());
      } else if (contentEncoding === "deflate") {
        responseStream = responseStream.pipe(zlib.createInflate());
      } else if (contentEncoding === "br") {
        responseStream = responseStream.pipe(zlib.createBrotliDecompress());
      }
      const shouldTransformOpenAiResponse = claudeResponsesBridge?.kind !== "responses"
        && !claudeMessagesCompaction
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
      // Cross-shape SSE translation: when the chain walker retargeted the
      // request to a different wire shape, the response is streamed in the
      // new shape's event format. Translate it back to the source shape.
      console.log(`[DEBUG sse] target.responseFromShape=${target.responseFromShape}, target.responseToShape=${target.responseToShape}, shapeBridge=${!!target.shapeBridge}`);
      const shapeBridge = target.shapeBridge;
      const sseBridge = (shapeBridge && target.responseFromShape && target.responseToShape
        && target.responseFromShape !== target.responseToShape
        && contentType.includes("event-stream"))
        ? shapeBridge
        : null;
      const sseTransform = sseBridge ? createShapeSseTransformStream(sseBridge) : null;
      if (claudeResponsesBridge?.kind === "responses" && contentType.includes("event-stream")) {
        responseStream = responseStream.pipe(createClaudeResponsesSseTransformStream(
          claudeResponsesBridge.originalRequest,
          diagnostics
        ));
      } else if (sseTransform) {
        responseStream = responseStream.pipe(sseTransform);
        responseStream.on("data", (c) => console.log(`[DEBUG sse->res] chunk len=${c.length}, sample=${c.toString().slice(0, 100)}`));
      } else if (shouldTransformOpenAiResponse) {
        responseStream = responseStream.pipe(createSseResponseTransformStream(
          target,
          contentType.includes("event-stream"),
          diagnostics,
          { fallbackModel: originalRequestModel }
        ));
      }
      responseStream.on("end", () => finishDiagnostics("end"));
      responseStream.on("close", () => finishDiagnostics("close"));
      res.on("close", () => {
        if (!res.writableEnded) finishDiagnostics("client_close");
      });
      res.on("error", () => finishDiagnostics("response_error"));
      if (streamStallWatchdogMs > 0
        && upstream.status >= 200
        && upstream.status < 300
        && contentType.includes("event-stream")) {
        const stallLabel = target.account?.alias || target.account?.email || target.account?.account_key || "provider";
        const stallErrorPayload = JSON.stringify({
          error: {
            message: `[codex-auth-advanced] Upstream stream from ${stallLabel} stalled: no data received for ${streamStallWatchdogMs}ms. Failing fast instead of hanging; retry the request.`,
            type: "codex_auth_advanced_stream_stall"
          }
        });
        const writeStallErrorEvent = () => {
          // Downstream transform streams (compaction/bridge) re-serialize
          // `data:` lines as JSON, so write the terminal event straight to the
          // client socket before tearing the pipeline down.
          try {
            res.write(`event: error\ndata: ${stallErrorPayload}\n\n`);
          } catch {
            // Response may already be closing; nothing else to write.
          }
        };
        let stallTimer = null;
        let stallFired = false;
        const clearStallWatchdog = () => {
          if (stallTimer) {
            clearTimeout(stallTimer);
            stallTimer = null;
          }
        };
        const fireStallWatchdog = () => {
          if (stallFired || res.writableEnded) return;
          stallFired = true;
          stallWatchdogFired = true;
          console.warn(`[Proxy Stream] ${req.url} stalled: no upstream bytes for ${streamStallWatchdogMs}ms; terminating with SSE error.`);
          finishDiagnostics("upstream_stall");
          const stallEventText = `event: error\ndata: ${stallErrorPayload}\n\n`;
          // Write the SSE error event as a raw HTTP chunk directly to the
          // socket, then the terminal zero-length chunk. The response stream
          // pipeline is backpressured by the stalled source and cannot be
          // relied on to flush res.write() calls. Headers were flushed at
          // writeHead time, so raw chunks here are framed correctly.
          const stallChunk = `${Buffer.byteLength(stallEventText).toString(16)}\r\n${stallEventText}\r\n`;
          try {
            res.socket?.write(stallChunk);
          } catch {
            // Socket may already be closing; nothing else to write.
          }
          watchdogStallTarget.destroy();
          // Defer the socket close until Node's write path has actually moved
          // the raw chunk out — res.socket.end() immediately after destroy()
          // can race the pipeline's cork/uncork and silently drop our bytes.
          setImmediate(() => {
            try {
              res.socket?.end();
            } catch {
              // Socket already closed.
            }
          });
        };
        const armStallWatchdog = () => {
          clearStallWatchdog();
          stallTimer = setTimeout(fireStallWatchdog, streamStallWatchdogMs);
          stallTimer.unref?.();
        };
        // Re-arm on raw upstream bytes; piped transforms emit no 'data' while
        // paused, but the raw source does whenever the origin actually sends.
        watchdogStallTarget.on("data", armStallWatchdog);
        responseStream.on("data", armStallWatchdog);
        responseStream.on("end", clearStallWatchdog);
        responseStream.on("close", clearStallWatchdog);
        res.on("close", clearStallWatchdog);
        armStallWatchdog();
      }
      responseStream.pipe(res);
    } catch (error) {
      console.error(`[Proxy Error] ${req.url} failed:`, error);
      writeProxyError(res, 502, `Provider proxy request failed: ${error?.message || error}`);
    }
  }

  function startProviderProxyServer() {
    // Prefix every line with an ISO timestamp so the detached log files are
    // grep-friendly when chasing a transient failure. We patch the console
    // methods only inside this function so other code paths (CLI commands,
    // tests) keep emitting bare messages.
    if (!startProviderProxyServer._consoleTimestamped) {
      const originalLog = console.log.bind(console);
      const originalWarn = console.warn.bind(console);
      const originalError = console.error.bind(console);
      const format = (args) => {
        const stamp = new Date().toISOString();
        const parts = args.map((arg) => {
          if (typeof arg === "string") return arg;
          try { return JSON.stringify(arg); } catch { return String(arg); }
        });
        return [`[${stamp}]`, ...parts];
      };
      console.log = (...args) => originalLog(...format(args));
      console.warn = (...args) => originalWarn(...format(args));
      console.error = (...args) => originalError(...format(args));
      startProviderProxyServer._consoleTimestamped = true;
    }

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
      const incoming = new URL(req.url || "/", `http://${providerProxyHost}:${providerProxyPort}`);
      const route = providerProxyRouteFromIncoming(incoming, providerProxyPrefix);
      const target = route.error ? { error: route.error, status: route.status } : targetUrlForProxyRequest(req, route);
      handleProviderProxyUpgrade({
        req, socket, head, target, route, captureChatgptCloudflareCookies
      }).catch((error) => {
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
      const response = await fetch(providerProxyHealthUrl(providerProxyHost, providerProxyPort, providerProxyPrefix), { signal: AbortSignal.timeout(700) });
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
    if (!quiet) process.stderr.write(`Warning: provider proxy did not respond at ${providerProxyHealthUrl(providerProxyHost, providerProxyPort, providerProxyPrefix)}.\n`);
    return false;
  }

  return {
    groupId: providerProxyGroupId,
    baseUrl: (codexHome) => providerProxyBaseUrl(providerProxyHost, providerProxyPort, providerProxyPrefix, codexHome),
    accountBaseUrl: (codexHome, account) => providerProxyAccountBaseUrl(providerProxyHost, providerProxyPort, providerProxyPrefix, codexHome, account),
    healthUrl: () => providerProxyHealthUrl(providerProxyHost, providerProxyPort, providerProxyPrefix),
    isBaseUrl: (url) => isProviderProxyBaseUrl(url, providerProxyHost, providerProxyPort, providerProxyPrefix),
    proxyRequestTargetUrl: (req, codexHome, target, routePath) => proxyRequestTargetUrl(req, codexHome, target, routePath || `${providerProxyPrefix}/${providerProxyGroupId(codexHome)}`, providerProxyHost, providerProxyPort),
    routeFromIncoming: (incoming) => providerProxyRouteFromIncoming(incoming, providerProxyPrefix),
    sanitizeRequestHeaders: sanitizeProxyRequestHeaders,
    startServer: startProviderProxyServer,
    isRunning: providerProxyIsRunning,
    ensureRunning: ensureProviderProxyRunning
  };
}
