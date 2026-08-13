import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import zlib from "node:zlib";

const repoRoot = new URL(".", import.meta.url).pathname;
const wrapper = path.join(repoRoot, "bin", "codex-auth-advanced.js");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-advanced-compact-"));
const codexHome = path.join(tempRoot, "codex-home");
const accountsDir = path.join(codexHome, "accounts");
const fakeBinDir = path.join(tempRoot, "bin");
fs.mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(fakeBinDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(fakeBinDir, "launchctl"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });

const upstreamRequests = [];
const compactFailures = [];
const responseFailures = [];
const claudeCompactionFailures = [];
const claudeMessageFailures = [];
let headerStallConnectionCloseCount = 0;
const claudeSseBody = [
  "event: message_start",
  `data: ${JSON.stringify({
    type: "message_start",
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-fake-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 4, output_tokens: 1 }
    }
  })}`,
  "",
  "event: content_block_delta",
  `data: ${JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "ok" }
  })}`,
  "",
  "event: message_stop",
  `data: ${JSON.stringify({ type: "message_stop" })}`,
  "",
  ""
].join("\n");
function responsesBridgeSseBody(model) {
  const response = {
    id: "resp_bridge_test",
    model,
    output: [{
      id: "msg_bridge_test",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "ok" }]
    }],
    usage: {
      input_tokens: 12,
      input_tokens_details: { cached_tokens: 2 },
      output_tokens: 1
    }
  };
  const events = [
    { type: "response.created", response: { id: response.id, model } },
    { type: "response.output_item.added", output_index: 0, item: { id: "msg_bridge_test", type: "message" } },
    { type: "response.content_part.added", output_index: 0, item_id: "msg_bridge_test", part: { type: "output_text", text: "" } },
    { type: "response.output_text.delta", output_index: 0, item_id: "msg_bridge_test", delta: "ok" },
    { type: "response.content_part.done", output_index: 0, item_id: "msg_bridge_test", part: { type: "output_text", text: "ok" } },
    { type: "response.output_item.done", output_index: 0, item: response.output[0] },
    { type: "response.completed", response }
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}
const usageTotalsByBearer = new Map([
  ["Bearer vsllm-secret", 28.097534],
  ["Bearer vsllm-2-secret", 96.242272]
]);
const officialAnthropicPathPrefix = "/official-anthropic";
const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const bodyText = Buffer.concat(chunks).toString("utf8");
  upstreamRequests.push({
    method: req.method,
    url: req.url,
    authorization: req.headers.authorization,
    apiKey: req.headers["x-api-key"],
    anthropicVersion: req.headers["anthropic-version"],
    anthropicBeta: req.headers["anthropic-beta"],
    claudeSessionId: req.headers["x-claude-code-session-id"],
    claudeAgentId: req.headers["x-claude-code-agent-id"],
    acceptEncoding: req.headers["accept-encoding"],
    contentEncoding: req.headers["content-encoding"],
    bodyText
  });
  const compactFailure = req.url.endsWith("/compact") ? compactFailures.shift() : null;
  if (req.method === "GET" && req.url.startsWith("/v1/usage?")) {
    const total = usageTotalsByBearer.get(req.headers.authorization) ?? 0;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      usage: {
        total: {
          actual_cost: total
        }
      }
    }));
    return;
  }
  if (req.method === "GET" && req.url.startsWith(`${officialAnthropicPathPrefix}/v1/models`)) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      data: [
        { id: "claude-fable-5", display_name: "Claude Fable 5", owned_by: "anthropic", max_input_tokens: 200000, max_tokens: 32000 },
        { id: "claude-sonnet-5", display_name: "Claude Sonnet 5", owned_by: "anthropic", max_input_tokens: 200000, max_tokens: 32000 }
      ]
    }));
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      data: [
        { id: "claude-fable-5", display_name: "Claude Fable 5", supported_endpoint_types: ["anthropic"] },
        { id: "claude-fake-5", display_name: "Claude Fake 5", supported_endpoint_types: ["anthropic"] },
        { id: "kimi-k3", display_name: "Kimi K3", supported_endpoint_types: ["anthropic"] },
        { id: "grok-4.5", display_name: "Grok 4.5", supported_endpoint_types: ["openai", "openai-response"] },
        { id: "grok-4.6", display_name: "Grok 4.6", supported_endpoint_types: ["openai"] },
        { id: "gpt-5.5", display_name: "GPT 5.5", supported_endpoint_types: ["openai", "anthropic"] }
      ]
    }));
    return;
  }
  if (req.method === "POST" && req.url.startsWith(`${officialAnthropicPathPrefix}/v1/messages`)) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache"
    });
    res.end(claudeSseBody);
    return;
  }
  if (req.method === "POST" && req.url.startsWith("/v1/messages")) {
    let parsedMessagesBody = null;
    try {
      parsedMessagesBody = JSON.parse(bodyText);
    } catch {
      parsedMessagesBody = null;
    }
    const lastMessage = Array.isArray(parsedMessagesBody?.messages)
      ? parsedMessagesBody.messages[parsedMessagesBody.messages.length - 1]
      : null;
    const lastContentText = typeof lastMessage?.content === "string"
      ? lastMessage.content
      : (Array.isArray(lastMessage?.content) ? lastMessage.content : []).map((part) => String(part?.text ?? "")).join("\n");
    const isCompactionPrompt = lastMessage?.role === "user"
      && /detailed summary of the conversation/i.test(lastContentText);
    if (isCompactionPrompt) {
      const failure = claudeCompactionFailures.shift();
      if (failure === "cloudflare_timeout") {
        res.writeHead(524, { "content-type": "application/json" });
        res.end(JSON.stringify({
          title: "Error 524: A timeout occurred",
          status: 524,
          detail: "The origin web server did not return a complete response within the 120-second Proxy Read Timeout window.",
          error_code: 524
        }));
        return;
      }
      if (failure === "unreachable") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "chat completions also down", code: "service_unavailable" } }));
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache"
      });
      res.end(claudeSseBody);
      return;
    }
    const messageFailure = claudeMessageFailures.shift();
    if (messageFailure === "api_key_ip_restriction") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: "IP access denied by API-Key restriction",
          code: "forbidden"
        }
      }));
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache"
    });
    res.end(claudeSseBody);
    return;
  }
  if (compactFailure) {
    if (compactFailure === "not_found") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: "Compact endpoint not found.",
          code: "not_found"
        }
      }));
      return;
    }
    res.writeHead(400, { "content-type": "application/json" });
    if (compactFailure === "missing_encrypted_content") {
      res.end(JSON.stringify({
        error: {
          message: "Missing required parameter: 'input[40].encrypted_content'.",
          param: "input[40].encrypted_content",
          code: "missing_required_parameter"
        }
      }));
    } else {
      res.end(JSON.stringify({
        error: {
          message: "The encrypted content could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
          code: "invalid_encrypted_content"
        }
      }));
    }
    return;
  }
  if (req.url.endsWith("/compact")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      object: "response.compaction",
      output: [
        { type: "message", role: "assistant", content: "compacted message text" }
      ]
    }));
  } else if (req.url.endsWith("/chat/completions")) {
    if (claudeCompactionFailures[0] === "unreachable") {
      claudeCompactionFailures.shift();
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "chat completions also down", code: "service_unavailable" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: "compacted message text"
          }
        }
      ]
    }));
  } else {
    const responseFailure = req.url.endsWith("/responses") ? responseFailures.shift() : null;
    if (responseFailure === "no_active_subscription") {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: "当前账户暂无生效套餐，请前往钱包页面激活订阅",
          code: "payment_required"
        }
      }));
      return;
    }
    if (responseFailure === "insufficient_balance") {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: "insufficient balance",
          code: "insufficient_balance"
        }
      }));
      return;
    }
    if (responseFailure === "transient_usage_limit") {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: "You've hit your usage limit. Try again later.",
          code: "usage_limit_reached"
        }
      }));
      return;
    }
    if (responseFailure === "model_capacity" || responseFailure === "model_capacity_slow_down") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: "Selected model is temporarily at capacity.",
          code: responseFailure === "model_capacity_slow_down" ? "slow_down" : "server_is_overloaded"
        }
      }));
      return;
    }
    if (responseFailure === "generic_service_unavailable") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: "Scheduled maintenance.",
          code: "service_unavailable"
        }
      }));
      return;
    }
    if (responseFailure === "delayed_completed") {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (responseFailure === "stall_stream") {
      // Mimic the VSLLM silent-origin failure: immediate SSE headers, then
      // nothing. Requires a streaming request body to reach the watchdog
      // (non-streaming requests only get the header bound).
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.flushHeaders();
      res.socket.on("error", () => {});
      return;
    }
    if (responseFailure === "stall_headers") {
      // Close after the proxy watchdog has already fired. The previous proxy
      // implementation tried to write a second response when this delayed
      // rejection arrived and crashed with ERR_HTTP_HEADERS_SENT.
      res.socket.on("error", () => {});
      res.once("close", () => {
        headerStallConnectionCloseCount += 1;
      });
      setTimeout(() => {
        if (!res.destroyed) res.destroy(new Error("delayed stalled-origin close"));
      }, 650).unref?.();
      return;
    }
    if (responseFailure === "network_error") {
      res.destroy(new Error("simulated upstream connection reset"));
      return;
    }
    let parsedBody = null;
    try {
      parsedBody = JSON.parse(bodyText);
    } catch {
      parsedBody = null;
    }
    if (req.url.endsWith("/responses")
      && (parsedBody?.model === "grok-4.5" || parsedBody?.model === "grok-4.6")
      && Array.isArray(parsedBody?.input)) {
      if (parsedBody.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(responsesBridgeSseBody(parsedBody.model));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "resp_bridge_nonstream",
          object: "response",
          model: parsedBody.model,
          output: [{
            id: "msg_bridge_nonstream",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "ok" }]
          }],
          usage: { input_tokens: 9, output_tokens: 1 }
        }));
      }
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "response.completed" }));
  }
});

function listen(server, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}

async function readProxyHealth(port) {
  const url = `http://127.0.0.1:${port}/_codex-auth-advanced/health`;
  try {
    const response = await fetch(url);
    if (response.status !== 200) return null;
    return response.json();
  } catch {
    return null;
  }
}

async function waitForHealth(port) {
  for (let i = 0; i < 50; i += 1) {
    const health = await readProxyHealth(port);
    if (health) return health;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("proxy did not become healthy");
}

function waitForChildExit(child, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      reject(new Error("proxy did not exit after graceful restart request"));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function proxyGroupId(home) {
  return Buffer.from(path.resolve(home), "utf8").toString("base64url");
}

function vsllmClaudeGatewayModelId(model, suffix = "") {
  return `claude-vsllm-${Buffer.from(model, "utf8").toString("base64url")}${suffix}`;
}

function writeAccount({
  key,
  alias,
  template,
  baseUrl,
  authMode = "apikey",
  createdAt = 0,
  spendLimitUsd = null,
  spendWindowMinutes = null,
  apiSpendWindow = null
}) {
  const authJson = authMode === "apikey"
    ? { OPENAI_API_KEY: `${alias}-secret` }
    : { tokens: { access_token: `${alias}-token` } };
  fs.writeFileSync(
    path.join(accountsDir, `${key}.auth.json`),
    JSON.stringify(authJson, null, 2),
    { mode: 0o600 }
  );
  if (authMode === "apikey") {
    fs.writeFileSync(
      path.join(accountsDir, `${key}.config.toml`),
      [
        'model_provider = "OpenAI"',
        'model = "gpt-5.5"',
        "",
        "[model_providers.OpenAI]",
        'name = "OpenAI"',
        `base_url = "${baseUrl}"`,
        'wire_api = "responses"',
        'requires_openai_auth = true',
        ""
      ].join("\n"),
      { mode: 0o600 }
    );
  }
  const account = {
    account_key: key,
    alias,
    email: alias,
    auth_mode: authMode,
    api_template: template,
    created_at: createdAt
  };
  if (Number.isFinite(spendLimitUsd)) account.api_spend_limit_usd = spendLimitUsd;
  if (Number.isFinite(spendWindowMinutes)) account.api_spend_window_minutes = spendWindowMinutes;
  if (apiSpendWindow) account.api_spend_window = apiSpendWindow;
  return account;
}

async function proxyRawRequest(port, suffix, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/_codex-auth-advanced/${proxyGroupId(codexHome)}${suffix}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
}

async function proxyAccountRawRequest(port, accountSelector, suffix, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/_codex-auth-advanced/${proxyGroupId(codexHome)}/accounts/${encodeURIComponent(accountSelector)}/v1${suffix}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
}

async function proxyAccountRequest(port, accountSelector, suffix, body, headers = {}) {
  const response = await proxyAccountRawRequest(port, accountSelector, suffix, body, headers);
  if (response.status !== 200) {
    throw new Error(`pinned proxy returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function proxyRequest(port, suffix, body) {
  const response = await proxyRawRequest(port, suffix, body);
  if (response.status !== 200) {
    throw new Error(`proxy returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function parseSseDataEvents(bodyText) {
  return bodyText
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6).trim())
    .filter((data) => data && data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

async function proxyGzipRequest(port, suffix, body) {
  const response = await fetch(`http://127.0.0.1:${port}/_codex-auth-advanced/${proxyGroupId(codexHome)}${suffix}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-encoding": "gzip"
    },
    body: zlib.gzipSync(Buffer.from(JSON.stringify(body)))
  });
  if (response.status !== 200) {
    throw new Error(`proxy returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function proxyUpgrade(port, suffix) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let response = "";
    socket.setTimeout(3000);
    socket.once("connect", () => {
      socket.write([
        `GET /_codex-auth-advanced/${proxyGroupId(codexHome)}${suffix} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "",
        ""
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
    });
    socket.once("timeout", () => {
      socket.destroy(new Error("upgrade request timed out"));
    });
    socket.once("error", reject);
    socket.once("close", () => resolve(response));
  });
}

function assertRequestAt(index, expected) {
  const latest = upstreamRequests[index];
  if (!latest) {
    throw new Error(`missing upstream request for ${expected.label} at index ${index}`);
  }
  if (latest.authorization !== `Bearer ${expected.bearer}`) {
    throw new Error(`unexpected authorization header for ${expected.label}: ${latest.authorization}`);
  }
  if (expected.acceptEncoding != null && latest.acceptEncoding !== expected.acceptEncoding) {
    throw new Error(`unexpected accept-encoding for ${expected.label}: ${latest.acceptEncoding}`);
  }
  if (Object.prototype.hasOwnProperty.call(expected, "contentEncoding") && latest.contentEncoding !== expected.contentEncoding) {
    throw new Error(`unexpected content-encoding for ${expected.label}: ${latest.contentEncoding}`);
  }
  if (expected.skipBodyAssertions) return;

  const parsed = JSON.parse(latest.bodyText);
  if (Object.prototype.hasOwnProperty.call(expected, "expectedModel")) {
    if (parsed.model !== expected.expectedModel) {
      throw new Error(`unexpected model for ${expected.label}: expected ${expected.expectedModel}, got ${parsed.model}`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(expected, "expectedReasoningEffort")) {
    const reasoningEffort = parsed.reasoning?.effort ?? parsed.reasoning_effort;
    if (reasoningEffort !== expected.expectedReasoningEffort) {
      throw new Error(`unexpected reasoning effort for ${expected.label}: expected ${expected.expectedReasoningEffort}, got ${reasoningEffort}`);
    }
  }
  const serialized = JSON.stringify(parsed);
  if (expected.expectEncryptedContent === true && !serialized.includes("encrypted")) {
    throw new Error(`${expected.label} should have preserved encrypted content`);
  }
  if (expected.expectEncryptedContent === false && serialized.includes("encrypted")) {
    throw new Error(`${expected.label} should have removed encrypted content`);
  }
  if (expected.expectReasoning === false && serialized.includes('"type":"reasoning"')) {
    throw new Error(`${expected.label} should have removed encrypted reasoning items`);
  }
  if (expected.expectEncryptedContent === false && parsed.input) {
    const assistantMsg = parsed.input.find(x => x.type === "message" && x.role === "assistant" && x.content === undefined);
    if (assistantMsg) {
      throw new Error(`expected encrypted-only assistant message to be removed, got ${JSON.stringify(assistantMsg)}`);
    }
  }
  if (expected.expectPlaintextCompactOnly) {
    for (const item of parsed.input || []) {
      if (item.type !== "message" || !["user", "assistant"].includes(item.role)) {
        throw new Error(`${expected.label} should only forward plaintext messages, got ${JSON.stringify(item)}`);
      }
      const content = Array.isArray(item.content) ? item.content : [];
      for (const part of content) {
        if (!["input_text", "output_text", "text"].includes(part.type) || typeof part.text !== "string") {
          throw new Error(`${expected.label} should only forward text content parts, got ${JSON.stringify(part)}`);
        }
      }
    }
  }
}

function assertLatestRequest(expected) {
  assertRequestAt(upstreamRequests.length - 1, expected);
}

function assertCompactResponseTextContent(label, compactResponse, expectedText = "compacted message text") {
  const message = compactResponse?.messages?.[0];
  const output = compactResponse?.output?.[0];
  if (!message || !output) {
    throw new Error(`${label} should include messages[0] and output[0], got: ${JSON.stringify(compactResponse)}`);
  }
  if (message.encrypted_content !== "" || output.encrypted_content !== "") {
    throw new Error(`${label} should include empty encrypted_content fields, got: ${JSON.stringify(compactResponse)}`);
  }
  if (message.content?.[0]?.text !== expectedText || output.content?.[0]?.text !== expectedText) {
    throw new Error(`${label} should preserve compact text content parts, got: ${JSON.stringify(compactResponse)}`);
  }
  if (message.content?.[0]?.type !== "output_text" || output.content?.[0]?.type !== "output_text") {
    throw new Error(`${label} should normalize compact text parts to output_text, got: ${JSON.stringify(compactResponse)}`);
  }
}

const upstreamPort = await listen(upstream);
const upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}`;
const nowSeconds = Math.floor(Date.now() / 1000);
const accounts = [
  writeAccount({ key: "apikey-codex-everywhere", alias: "codex-everywhere", template: null, baseUrl: upstreamBaseUrl }),
  writeAccount({ key: "apikey-tcdmx", alias: "tcdmx", template: null, baseUrl: upstreamBaseUrl }),
  writeAccount({
    key: "apikey-vsllm",
    alias: "vsllm",
    template: null,
    baseUrl: upstreamBaseUrl,
    apiSpendWindow: {
      window_minutes: 300,
      total_spend_usd: 28.097534,
      samples: [{ at: nowSeconds, spend_usd: 5.262316, total_spend_usd: 28.097534 }],
      updated_at: nowSeconds
    }
  }),
  writeAccount({
    key: "apikey-vsllm-2",
    alias: "vsllm-2",
    template: null,
    baseUrl: upstreamBaseUrl,
    createdAt: 10,
    spendLimitUsd: 55,
    spendWindowMinutes: 480,
    apiSpendWindow: {
      window_minutes: 480,
      total_spend_usd: 96.242272,
      samples: [{ at: nowSeconds, spend_usd: 55.370052, total_spend_usd: 96.242272 }],
      updated_at: nowSeconds
    }
  }),
  writeAccount({ key: "apikey-openai", alias: "openai", template: "openai", baseUrl: upstreamBaseUrl }),
  writeAccount({ key: "chatgpt-business", alias: "business", template: null, baseUrl: upstreamBaseUrl, authMode: "chatgpt" })
];

function setActive(accountKey, autoSwitch = false) {
  fs.writeFileSync(
    path.join(accountsDir, "registry.json"),
    JSON.stringify({ active_account_key: accountKey, auto_switch: { enabled: autoSwitch }, accounts }, null, 2),
    { mode: 0o600 }
  );
}

function runWrapper(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapper, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: tempRoot,
        PATH: `${fakeBinDir}:${process.env.PATH || ""}`,
        CODEX_HOME: codexHome,
        CODEX_AUTH_ADVANCED_PROXY_PORT: String(proxyPort),
        CODEX_AUTH_ADVANCED_ANTHROPIC_BASE_URL: `${upstreamBaseUrl}${officialAnthropicPathPrefix}`
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if ((code ?? 1) !== 0 || signal) {
        reject(new Error(`wrapper ${args.join(" ")} failed with ${signal || code}:\n${stdout}\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function readRegistry() {
  return JSON.parse(fs.readFileSync(path.join(accountsDir, "registry.json"), "utf8"));
}

const proxyServer = http.createServer();
await listen(proxyServer);
const proxyPort = proxyServer.address().port;
await new Promise((resolve) => proxyServer.close(resolve));

const proxy = spawn(process.execPath, [wrapper, "proxy", "serve"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CODEX_HOME: codexHome,
    CODEX_AUTH_ADVANCED_PROXY_PORT: String(proxyPort),
    CODEX_AUTH_ADVANCED_CHATGPT_BASE_URL: upstreamBaseUrl,
    CODEX_AUTH_ADVANCED_ANTHROPIC_BASE_URL: `${upstreamBaseUrl}${officialAnthropicPathPrefix}`,
    CODEX_AUTH_ADVANCED_MODEL_CAPACITY_RETRY_BASE_MS: "5",
    CODEX_AUTH_ADVANCED_STREAM_STALL_WATCHDOG_MS: "400"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

try {
  setActive("apikey-vsllm");
  await runWrapper(["config", "api-spend-limit", "vsllm-2", "55"]);
  const syncedRegistry = readRegistry();
  const syncedVsllm = syncedRegistry.accounts.find((account) => account.account_key === "apikey-vsllm");
  const syncedVsllm2 = syncedRegistry.accounts.find((account) => account.account_key === "apikey-vsllm-2");
  if (syncedVsllm?.api_spend?.exhausted === true) {
    throw new Error(`expected vsllm without an explicit cap to remain usable, got ${JSON.stringify(syncedVsllm)}`);
  }
  if (syncedVsllm?.api_spend?.limit_usd != null) {
    throw new Error(`expected vsllm without an explicit cap to have no enforced limit, got ${JSON.stringify(syncedVsllm.api_spend)}`);
  }
  if (syncedVsllm?.api_spend?.window_minutes !== 480) {
    throw new Error(`expected vsllm to default to an 8-hour rolling window, got ${JSON.stringify(syncedVsllm?.api_spend)}`);
  }
  if (syncedVsllm2?.api_spend?.exhausted !== true) {
    throw new Error(`expected explicitly capped vsllm-2 to be marked exhausted, got ${JSON.stringify(syncedVsllm2)}`);
  }
  if (syncedVsllm2?.api_spend?.limit_usd !== 55) {
    throw new Error(`expected vsllm-2 to keep its explicit $55 limit, got ${JSON.stringify(syncedVsllm2?.api_spend)}`);
  }
  if (syncedVsllm2?.api_spend_window_minutes !== 480 || syncedVsllm2?.api_spend?.window_minutes !== 480) {
    throw new Error(`expected vsllm-2 $55 cap to use an 8-hour rolling window, got ${JSON.stringify(syncedVsllm2)}`);
  }
  const syncedVsllm2ResetAt = Number(syncedVsllm2?.last_usage?.primary?.resets_at);
  if (!Number.isFinite(syncedVsllm2ResetAt) || syncedVsllm2ResetAt <= nowSeconds || syncedVsllm2ResetAt > nowSeconds + 480 * 60 + 30) {
    throw new Error(`expected exhausted vsllm-2 to store a reset time from its 8-hour rolling window, got ${JSON.stringify(syncedVsllm2?.last_usage)}`);
  }
  await runWrapper(["config", "auto", "disable"]);
  const autoConfigRegistry = readRegistry();
  const preservedVsllm2 = autoConfigRegistry.accounts.find((account) => account.account_key === "apikey-vsllm-2");
  if (preservedVsllm2?.api_spend_limit_usd !== 55 || preservedVsllm2?.api_spend_window_minutes !== 480) {
    throw new Error(`expected auto config rewrite to preserve vsllm-2 cap metadata, got ${JSON.stringify(preservedVsllm2)}`);
  }
  accounts.splice(0, accounts.length, ...autoConfigRegistry.accounts);

  const switchResult = await runWrapper(["switch", "--live"]);
  if (!switchResult.stdout.includes("PRIMARY LEFT") || !switchResult.stdout.includes("EXHAUSTED")) {
    throw new Error(`expected switch output to include shared account table columns, got:\n${switchResult.stdout}`);
  }
  if (!switchResult.stdout.includes("vsllm") || !switchResult.stdout.includes("vsllm-2")) {
    throw new Error(`expected switch output to include vsllm accounts, got:\n${switchResult.stdout}`);
  }

  await waitForHealth(proxyPort);
  const body = {
    reasoning: {
      effort: "xhigh",
      summary: "auto"
    },
    input: [
      {
        type: "reasoning",
        encrypted_content: "encrypted-old-provider-state"
      },
      {
        type: "reasoning",
        encryptedContent: "encrypted-old-provider-state-camel"
      },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "old reasoning summary" }],
        encrypted_content: "encrypted-old-provider-state-with-summary"
      },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "old reasoning summary without encrypted content" }]
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "compact this" }]
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "previous plaintext assistant answer" }]
      },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "provider-specific developer instruction" }]
      },
      {
        type: "function_call",
        name: "exec_command",
        call_id: "call_test",
        arguments: "{}"
      },
      {
        type: "function_call_output",
        call_id: "call_test",
        output: "tool output"
      },
      {
        type: "message",
        role: "assistant",
        encrypted_content: "encrypted-assistant-message"
      }
    ]
  };
  const aliasedModelBody = {
    ...body,
    model: "gpt-5.2"
  };
  const vsllmModelMappings = [
    ["gpt-5.6-sol", "gpt-5.6-sol", "ultra"],
    ["gpt-5.6-sol-pro20x", "gpt-5.6-sol", "ultra"],
    ["gpt-5.6-terra", "gpt-5.6-terra", "ultra"],
    ["gpt-5.6-terra-pro20x", "gpt-5.6-terra", "ultra"],
    ["gpt-5.6-luna", "gpt-5.6-luna", "max"],
    ["gpt-5.6-luna-pro20x", "gpt-5.6-luna", "max"]
  ];

  setActive("apikey-vsllm");
  await proxyRequest(proxyPort, "/responses", aliasedModelBody);
  assertLatestRequest({
    label: "vsllm responses model alias",
    bearer: "vsllm-secret",
    acceptEncoding: "identity",
    expectEncryptedContent: true,
    expectedModel: "gpt-5.5",
    expectedReasoningEffort: "xhigh"
  });

  const remoteCompactionV2Body = {
    model: "gpt-5.6-sol",
    stream: true,
    reasoning: {
      effort: "ultra",
      summary: "auto"
    },
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        request_kind: "compaction",
        compaction: {
          implementation: "responses_compaction_v2",
          trigger: "manual"
        }
      })
    },
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "important prior context" }]
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "prior answer" }]
      },
      { type: "compaction_trigger" }
    ]
  };
  const beforeRemoteCompactionV2 = upstreamRequests.length;
  const remoteCompactionV2 = await proxyRawRequest(proxyPort, "/responses", remoteCompactionV2Body);
  const remoteCompactionV2Text = await remoteCompactionV2.text();
  if (remoteCompactionV2.status !== 200) {
    throw new Error(`remote compaction v2 should return 200, got ${remoteCompactionV2.status}:\n${remoteCompactionV2Text}`);
  }
  if (!String(remoteCompactionV2.headers.get("content-type") || "").includes("text/event-stream")) {
    throw new Error(`remote compaction v2 should return SSE, got ${remoteCompactionV2.headers.get("content-type")}`);
  }
  if (upstreamRequests.length !== beforeRemoteCompactionV2 + 1) {
    throw new Error(`remote compaction v2 should make one provider-compatible summarization request, got ${upstreamRequests.length - beforeRemoteCompactionV2}`);
  }
  const remoteCompactionFallbackRequest = upstreamRequests.at(-1);
  if (!remoteCompactionFallbackRequest?.url.endsWith("/chat/completions")) {
    throw new Error(`remote compaction v2 should use chat completions, got ${remoteCompactionFallbackRequest?.url}`);
  }
  const remoteCompactionFallbackBody = JSON.parse(remoteCompactionFallbackRequest.bodyText);
  if (remoteCompactionFallbackBody.model !== "gpt-5.6-sol") {
    throw new Error(`remote compaction v2 should preserve the selected model, got ${remoteCompactionFallbackRequest.bodyText}`);
  }
  if (remoteCompactionFallbackBody.reasoning_effort !== "ultra") {
    throw new Error(`remote compaction v2 should preserve Codex reasoning effort, got ${remoteCompactionFallbackRequest.bodyText}`);
  }
  const remoteCompactionFallbackSerialized = JSON.stringify(remoteCompactionFallbackBody);
  if (!remoteCompactionFallbackSerialized.includes("important prior context")
    || !remoteCompactionFallbackSerialized.includes("prior answer")
    || remoteCompactionFallbackSerialized.includes("compaction_trigger")) {
    throw new Error(`remote compaction v2 should summarize the readable conversation without forwarding its trigger, got ${remoteCompactionFallbackRequest.bodyText}`);
  }
  const remoteCompactionV2Events = parseSseDataEvents(remoteCompactionV2Text);
  const remoteCompactionOutputEvents = remoteCompactionV2Events.filter((event) => event.type === "response.output_item.done");
  const remoteCompactionCompletedEvents = remoteCompactionV2Events.filter((event) => event.type === "response.completed");
  if (remoteCompactionOutputEvents.length !== 1
    || remoteCompactionOutputEvents[0]?.item?.type !== "compaction"
    || !String(remoteCompactionOutputEvents[0]?.item?.encrypted_content || "").startsWith("codex-auth-advanced:remote-compaction-v2:")) {
    throw new Error(`remote compaction v2 should emit exactly one tagged compaction item, got:\n${remoteCompactionV2Text}`);
  }
  if (remoteCompactionCompletedEvents.length !== 1
    || !String(remoteCompactionCompletedEvents[0]?.response?.id || "").startsWith("resp_compact_")) {
    throw new Error(`remote compaction v2 should emit one response.completed event, got:\n${remoteCompactionV2Text}`);
  }

  const beforeCompactedFollowUp = upstreamRequests.length;
  await proxyRequest(proxyPort, "/responses", {
    model: "gpt-5.6-sol",
    input: [
      remoteCompactionOutputEvents[0].item,
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "continue after compaction" }]
      }
    ]
  });
  if (upstreamRequests.length !== beforeCompactedFollowUp + 1) {
    throw new Error(`a post-compaction turn should make one normal responses request, got ${upstreamRequests.length - beforeCompactedFollowUp}`);
  }
  const compactedFollowUpBody = JSON.parse(upstreamRequests.at(-1).bodyText);
  const compactedFollowUpSerialized = JSON.stringify(compactedFollowUpBody);
  const expandedSummary = compactedFollowUpBody.input?.find((item) => item.type === "message" && item.role === "developer");
  if (compactedFollowUpSerialized.includes("codex-auth-advanced:remote-compaction-v2:")
    || compactedFollowUpBody.input?.some((item) => item.type === "compaction")
    || !JSON.stringify(expandedSummary).includes("compacted message text")) {
    throw new Error(`a proxy-generated compaction item should expand into readable provider context, got ${upstreamRequests.at(-1).bodyText}`);
  }

  claudeCompactionFailures.push("unreachable");
  const beforeRemoteCompactionDummy = upstreamRequests.length;
  const remoteCompactionDummy = await proxyRawRequest(proxyPort, "/responses", remoteCompactionV2Body);
  const remoteCompactionDummyText = await remoteCompactionDummy.text();
  const remoteCompactionDummyEvents = parseSseDataEvents(remoteCompactionDummyText);
  if (remoteCompactionDummy.status !== 200
    || upstreamRequests.length !== beforeRemoteCompactionDummy + 1
    || remoteCompactionDummyEvents.filter((event) => event.type === "response.output_item.done" && event.item?.type === "compaction").length !== 1
    || remoteCompactionDummyEvents.filter((event) => event.type === "response.completed").length !== 1) {
    throw new Error(`remote compaction v2 failure should still return a protocol-compatible terminal stream, got:\n${remoteCompactionDummyText}`);
  }

  const compactRes1 = await proxyRequest(proxyPort, "/responses/compact", body);
  const latestReq = upstreamRequests.at(-1);
  if (!latestReq || !latestReq.url.endsWith("/responses/compact")) {
    throw new Error(`expected vsllm to use native compact endpoint, got url: ${latestReq?.url}`);
  }
  assertLatestRequest({ label: "vsllm native compact", bearer: "vsllm-secret", acceptEncoding: "identity", expectEncryptedContent: true, expectedReasoningEffort: "xhigh" });
  assertCompactResponseTextContent("vsllm native compact response", compactRes1);

  compactFailures.push("not_found");
  const beforeVsllmFallback = upstreamRequests.length;
  const compactRes1Fallback = await proxyRequest(proxyPort, "/responses/compact", body);
  if (upstreamRequests.length !== beforeVsllmFallback + 2) {
    throw new Error(`expected vsllm compact fallback to make 2 upstream requests, got ${upstreamRequests.length - beforeVsllmFallback}`);
  }
  assertRequestAt(beforeVsllmFallback, { label: "vsllm compact first attempt", bearer: "vsllm-secret", acceptEncoding: "identity", expectEncryptedContent: true, expectedReasoningEffort: "xhigh" });
  const vsllmFallbackReq = upstreamRequests.at(-1);
  if (!vsllmFallbackReq || !vsllmFallbackReq.url.endsWith("/chat/completions")) {
    throw new Error(`expected vsllm compact fallback to use chat completions, got url: ${vsllmFallbackReq?.url}`);
  }
  const vsllmFallbackReqBody = JSON.parse(vsllmFallbackReq.bodyText);
  if (vsllmFallbackReqBody.stream === true) {
    throw new Error(`expected vsllm compact fallback to use non-streaming chat completions, got: ${vsllmFallbackReq.bodyText}`);
  }
  if (!Array.isArray(vsllmFallbackReqBody.messages) || vsllmFallbackReqBody.messages.length !== 2) {
    throw new Error(`expected vsllm compact fallback to send chat messages, got: ${vsllmFallbackReq.bodyText}`);
  }
  assertLatestRequest({ label: "vsllm compact fallback", bearer: "vsllm-secret", acceptEncoding: "identity", expectEncryptedContent: false, expectedReasoningEffort: "xhigh" });
  assertCompactResponseTextContent("vsllm compact fallback response", compactRes1Fallback);

  const aliasedCompactRes = await proxyRequest(proxyPort, "/responses/compact", aliasedModelBody);
  assertLatestRequest({
    label: "vsllm compact model alias",
    bearer: "vsllm-secret",
    acceptEncoding: "identity",
    expectEncryptedContent: true,
    expectedModel: "gpt-5.5-openai-compact"
  });
  assertCompactResponseTextContent("vsllm compact aliased response", aliasedCompactRes);

  compactFailures.push("not_found");
  const beforeAliasedVsllmFallback = upstreamRequests.length;
  await proxyRequest(proxyPort, "/responses/compact", aliasedModelBody);
  if (upstreamRequests.length !== beforeAliasedVsllmFallback + 2) {
    throw new Error(`expected aliased vsllm compact fallback to make 2 upstream requests, got ${upstreamRequests.length - beforeAliasedVsllmFallback}`);
  }
  assertRequestAt(beforeAliasedVsllmFallback, {
    label: "vsllm compact alias first attempt",
    bearer: "vsllm-secret",
    acceptEncoding: "identity",
    expectEncryptedContent: true,
    expectedModel: "gpt-5.5-openai-compact"
  });
  assertRequestAt(beforeAliasedVsllmFallback + 1, {
    label: "vsllm compact alias fallback",
    bearer: "vsllm-secret",
    acceptEncoding: "identity",
    expectEncryptedContent: false,
    expectedModel: "gpt-5.2"
  });

  for (const [inputModel, expectedModel, expectedReasoningEffort] of vsllmModelMappings) {
    const aliasBody = {
      ...body,
      model: inputModel,
      reasoning: {
        ...body.reasoning,
        effort: expectedReasoningEffort
      }
    };
    await proxyRequest(proxyPort, "/responses", aliasBody);
    assertLatestRequest({
      label: `vsllm ${inputModel} responses model alias`,
      bearer: "vsllm-secret",
      acceptEncoding: "identity",
      expectEncryptedContent: true,
      expectedModel,
      expectedReasoningEffort
    });

    const compactAliasResponse = await proxyRequest(proxyPort, "/responses/compact", aliasBody);
    assertLatestRequest({
      label: `vsllm ${inputModel} compact model alias`,
      bearer: "vsllm-secret",
      acceptEncoding: "identity",
      expectEncryptedContent: true,
      expectedModel,
      expectedReasoningEffort
    });
    assertCompactResponseTextContent(`vsllm ${inputModel} compact aliased response`, compactAliasResponse);

    compactFailures.push("not_found");
    const beforeCompactAliasFallback = upstreamRequests.length;
    await proxyRequest(proxyPort, "/responses/compact", aliasBody);
    if (upstreamRequests.length !== beforeCompactAliasFallback + 2) {
      throw new Error(`expected ${inputModel} compact fallback to make 2 upstream requests, got ${upstreamRequests.length - beforeCompactAliasFallback}`);
    }
    assertRequestAt(beforeCompactAliasFallback, {
      label: `vsllm ${inputModel} compact alias first attempt`,
      bearer: "vsllm-secret",
      acceptEncoding: "identity",
      expectEncryptedContent: true,
      expectedModel,
      expectedReasoningEffort
    });
    assertRequestAt(beforeCompactAliasFallback + 1, {
      label: `vsllm ${inputModel} compact alias fallback`,
      bearer: "vsllm-secret",
      acceptEncoding: "identity",
      expectEncryptedContent: false,
      expectedModel: inputModel,
      expectedReasoningEffort
    });
  }

  const claudeModelRoutes = [
    { inputModel: vsllmClaudeGatewayModelId("claude-fable-5"), expectedModel: "claude-fable-5", wireApi: "anthropic" },
    { inputModel: vsllmClaudeGatewayModelId("claude-fake-5"), expectedModel: "claude-fake-5", wireApi: "anthropic" },
    { inputModel: vsllmClaudeGatewayModelId("gpt-5.5"), expectedModel: "gpt-5.5", wireApi: "anthropic" },
    { inputModel: vsllmClaudeGatewayModelId("kimi-k3", "[1m]"), expectedModel: "kimi-k3", wireApi: "anthropic" },
    { inputModel: vsllmClaudeGatewayModelId("grok-4.5", "[1m]"), expectedModel: "grok-4.5", wireApi: "responses" },
    { inputModel: vsllmClaudeGatewayModelId("grok-4.6", "[1m]"), expectedModel: "grok-4.6", wireApi: "responses" },
    { inputModel: "claude-fake-5", expectedModel: "claude-fake-5", wireApi: "anthropic" },
    { inputModel: "grok-4.5[1m]", expectedModel: "grok-4.5", wireApi: "responses" },
    { inputModel: "grok-4.6[1m]", expectedModel: "grok-4.6", wireApi: "responses" },
    { inputModel: "kimi-k3[1m]", expectedModel: "kimi-k3", wireApi: "anthropic" },
    { inputModel: "claude-fable-5-dd-3k-imik", expectedModel: "kimi-k3", wireApi: "anthropic" },
    { inputModel: "claude-fable-5-dd-3k-imik[1m]", expectedModel: "kimi-k3", wireApi: "anthropic" },
    { inputModel: "claude-fable-5-dd-5.4-korg", expectedModel: "grok-4.5", wireApi: "responses" },
    { inputModel: "claude-fable-5-dd-5.4-korg[1m]", expectedModel: "grok-4.5", wireApi: "responses" },
    { inputModel: "claude-fable-5-dd-6.4-korg", expectedModel: "grok-4.6", wireApi: "responses" },
    { inputModel: "claude-fable-5-dd-6.4-korg[1m]", expectedModel: "grok-4.6", wireApi: "responses" }
  ];
  for (const { inputModel, expectedModel, wireApi } of claudeModelRoutes) {
    const beforeClaudeRequest = upstreamRequests.length;
    const response = await proxyRawRequest(proxyPort, "/v1/messages?beta=true", {
      model: inputModel,
      max_tokens: 256,
      stream: true,
      system: [{ type: "text", text: "Keep the response short." }],
      messages: [{ role: "user", content: "Reply with ok." }]
    }, {
      authorization: "Bearer local-claude-marker",
      "x-api-key": "local-claude-api-key-marker",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "test-beta-2026-07-17",
      "x-claude-code-session-id": "session-test",
      "x-claude-code-agent-id": "agent-test"
    });
    if (response.status !== 200) {
      throw new Error(`Claude ${inputModel} request failed with ${response.status}: ${await response.text()}`);
    }
    const responseText = await response.text();
    if (wireApi === "anthropic" && responseText !== claudeSseBody) {
      throw new Error(`Claude ${inputModel} native Anthropic SSE response was modified:\n${responseText}`);
    }
    if (wireApi === "responses"
      && (!responseText.includes("event: message_start")
        || !responseText.includes('"type":"text_delta","text":"ok"')
        || !responseText.includes('"stop_reason":"end_turn"')
        || !responseText.includes("event: message_stop"))) {
      throw new Error(`Claude ${inputModel} Responses SSE was not translated to Anthropic events:\n${responseText}`);
    }
    if (responseText.includes("encrypted_content") || responseText.includes("response.completed")) {
      throw new Error(`Claude ${inputModel} SSE response must not receive OpenAI encrypted_content fields`);
    }
    if (upstreamRequests.length !== beforeClaudeRequest + 1) {
      throw new Error(`Claude ${inputModel} request should make one upstream request`);
    }
    const claudeRequest = upstreamRequests.at(-1);
    const expectedUrl = wireApi === "responses" ? "/v1/responses" : "/v1/messages?beta=true";
    if (claudeRequest.url !== expectedUrl) {
      throw new Error(`Claude ${inputModel} request used the wrong upstream path: ${claudeRequest.url}`);
    }
    if (claudeRequest.authorization !== "Bearer vsllm-secret" || claudeRequest.apiKey !== undefined) {
      throw new Error(`Claude ${inputModel} request did not replace local credentials with the active account key`);
    }
    if (claudeRequest.claudeSessionId !== "session-test"
      || claudeRequest.claudeAgentId !== "agent-test") {
      throw new Error(`Claude ${inputModel} session headers were not preserved: ${JSON.stringify(claudeRequest)}`);
    }
    if (wireApi === "anthropic"
      && (claudeRequest.anthropicVersion !== "2023-06-01" || claudeRequest.anthropicBeta !== "test-beta-2026-07-17")) {
      throw new Error(`Claude ${inputModel} Anthropic headers were not preserved: ${JSON.stringify(claudeRequest)}`);
    }
    if (wireApi === "responses"
      && (claudeRequest.anthropicVersion !== undefined || claudeRequest.anthropicBeta !== undefined)) {
      throw new Error(`Claude ${inputModel} Anthropic headers leaked into the Responses request: ${JSON.stringify(claudeRequest)}`);
    }
    const claudeBody = JSON.parse(claudeRequest.bodyText);
    if (claudeBody.model !== expectedModel) {
      throw new Error(`Claude ${inputModel} should map to ${expectedModel}, got ${claudeBody.model}`);
    }
    if (wireApi === "anthropic"
      && (claudeBody.system?.[0]?.text !== "Keep the response short." || claudeBody.messages?.[0]?.content !== "Reply with ok.")) {
      throw new Error(`Claude ${inputModel} native request body fields were not preserved`);
    }
    if (wireApi === "responses"
      && (claudeBody.input?.[0]?.role !== "developer"
        || claudeBody.input?.[0]?.content?.[0]?.text !== "Keep the response short."
        || claudeBody.input?.[1]?.role !== "user"
        || claudeBody.input?.[1]?.content?.[0]?.text !== "Reply with ok."
        || claudeBody.store !== false
        || claudeBody.stream !== true)) {
      throw new Error(`Claude ${inputModel} request body was not translated to Responses format: ${claudeRequest.bodyText}`);
    }
  }

  const beforeOfficialClaudeRequest = upstreamRequests.length;
  const officialClaudeResponse = await proxyRawRequest(proxyPort, "/v1/messages?beta=true", {
    model: "claude-fable-5",
    max_tokens: 256,
    stream: true,
    messages: [{ role: "user", content: "Reply with the official model." }]
  }, {
    authorization: "Bearer official-oauth",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "test-beta-2026-07-17",
    "x-claude-code-session-id": "official-session",
    "x-claude-code-agent-id": "official-agent"
  });
  if (officialClaudeResponse.status !== 200 || await officialClaudeResponse.text() !== claudeSseBody) {
    throw new Error("official Claude request did not preserve the Anthropic Messages response");
  }
  if (upstreamRequests.length !== beforeOfficialClaudeRequest + 1) {
    throw new Error("official Claude request should make exactly one upstream request");
  }
  const officialClaudeRequest = upstreamRequests.at(-1);
  if (officialClaudeRequest?.url !== `${officialAnthropicPathPrefix}/v1/messages?beta=true`
    || officialClaudeRequest.authorization !== "Bearer official-oauth"
    || officialClaudeRequest.apiKey !== undefined
    || officialClaudeRequest.anthropicVersion !== "2023-06-01"
    || officialClaudeRequest.anthropicBeta !== "test-beta-2026-07-17"
    || officialClaudeRequest.claudeSessionId !== "official-session"
    || officialClaudeRequest.claudeAgentId !== "official-agent"
    || JSON.parse(officialClaudeRequest.bodyText).model !== "claude-fable-5") {
    throw new Error(`official Claude request did not preserve OAuth routing: ${JSON.stringify(officialClaudeRequest)}`);
  }

  const claudeCompactionBody = {
    model: "kimi-k3",
    max_tokens: 4096,
    stream: true,
    system: [{ type: "text", text: "You are Claude Code." }],
    messages: [
      {
        role: "user",
        content: "Your task is to create a detailed summary of the conversation so far, paying special attention to the user's explicit requests and your previous actions.\n\n<conversation>user: hello\nassistant: hi there</conversation>"
      }
    ]
  };

  const beforeClaudeCompactSuccess = upstreamRequests.length;
  const claudeCompactSuccess = await proxyRawRequest(proxyPort, "/v1/messages", claudeCompactionBody, {
    "anthropic-version": "2023-06-01"
  });
  const claudeCompactSuccessText = await claudeCompactSuccess.text();
  if (claudeCompactSuccess.status !== 200 || claudeCompactSuccessText !== claudeSseBody) {
    throw new Error(`Claude compaction normal request should pass through untouched, got ${claudeCompactSuccess.status}: ${claudeCompactSuccessText}`);
  }
  if (upstreamRequests.length !== beforeClaudeCompactSuccess + 1
    || !upstreamRequests.at(-1)?.url.startsWith("/v1/messages")) {
    throw new Error(`Claude compaction normal request should make exactly one /v1/messages upstream request, got ${JSON.stringify(upstreamRequests.at(-1))}`);
  }

  claudeCompactionFailures.push("cloudflare_timeout");
  const beforeClaudeCompactFallback = upstreamRequests.length;
  const claudeCompactFallback = await proxyRawRequest(proxyPort, "/v1/messages", claudeCompactionBody, {
    "anthropic-version": "2023-06-01"
  });
  const claudeCompactFallbackText = await claudeCompactFallback.text();
  if (claudeCompactFallback.status !== 200) {
    throw new Error(`Claude compaction fallback should return 200, got ${claudeCompactFallback.status}: ${claudeCompactFallbackText}`);
  }
  if (!claudeCompactFallback.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error(`Claude compaction fallback should be SSE, got content-type ${claudeCompactFallback.headers.get("content-type")}`);
  }
  if (!claudeCompactFallbackText.includes("event: message_start")
    || !claudeCompactFallbackText.includes('"type":"text_delta","text":"compacted message text"')
    || !claudeCompactFallbackText.includes('"stop_reason":"end_turn"')
    || !claudeCompactFallbackText.includes("event: message_stop")) {
    throw new Error(`Claude compaction fallback SSE is malformed:\n${claudeCompactFallbackText}`);
  }
  if (claudeCompactFallbackText.includes('"model":"kimi-k3"') !== true) {
    throw new Error(`Claude compaction fallback should echo the request model, got:\n${claudeCompactFallbackText}`);
  }
  if (upstreamRequests.length !== beforeClaudeCompactFallback + 2) {
    throw new Error(`Claude compaction fallback should make 2 upstream requests (/v1/messages 524 then /chat/completions), got ${upstreamRequests.length - beforeClaudeCompactFallback}`);
  }
  assertRequestAt(beforeClaudeCompactFallback, { label: "claude compaction first attempt", bearer: "vsllm-secret", acceptEncoding: "identity" });
  const claudeCompactFallbackReq = upstreamRequests.at(-1);
  if (!claudeCompactFallbackReq?.url.endsWith("/chat/completions")) {
    throw new Error(`Claude compaction fallback should use chat completions, got url: ${claudeCompactFallbackReq?.url}`);
  }
  const claudeCompactFallbackReqBody = JSON.parse(claudeCompactFallbackReq.bodyText);
  if (claudeCompactFallbackReqBody.model !== "kimi-k3") {
    throw new Error(`Claude compaction fallback should keep model kimi-k3, got ${claudeCompactFallbackReq.bodyText}`);
  }
  if (claudeCompactFallbackReqBody.stream === true) {
    throw new Error(`Claude compaction fallback should use non-streaming chat completions, got ${claudeCompactFallbackReq.bodyText}`);
  }
  if (claudeCompactFallbackReqBody.messages?.[0]?.content?.includes("detailed summary of the conversation") !== true) {
    throw new Error(`Claude compaction fallback should forward the transcript text, got ${claudeCompactFallbackReq.bodyText}`);
  }

  claudeCompactionFailures.push("cloudflare_timeout", "unreachable");
  const beforeClaudeCompactDummy = upstreamRequests.length;
  const claudeCompactDummy = await proxyRawRequest(proxyPort, "/v1/messages", claudeCompactionBody, {
    "anthropic-version": "2023-06-01"
  });
  const claudeCompactDummyText = await claudeCompactDummy.text();
  if (claudeCompactDummy.status !== 200
    || !claudeCompactDummyText.includes("COMPACTION FALLBACK WARNING")
    || !claudeCompactDummyText.includes("event: message_stop")) {
    throw new Error(`Claude compaction dummy fallback should return a warning SSE message, got ${claudeCompactDummy.status}:\n${claudeCompactDummyText}`);
  }
  if (upstreamRequests.length !== beforeClaudeCompactDummy + 2) {
    throw new Error(`Claude compaction dummy path should attempt /v1/messages then /chat/completions, got ${upstreamRequests.length - beforeClaudeCompactDummy} upstream requests`);
  }

  const beforeClaudeNormal = upstreamRequests.length;
  const claudeNormalResponse = await proxyRawRequest(proxyPort, "/v1/messages", {
    model: "kimi-k3",
    max_tokens: 64,
    stream: true,
    messages: [{ role: "user", content: "Reply with ok." }]
  }, {
    "anthropic-version": "2023-06-01"
  });
  const claudeNormalText = await claudeNormalResponse.text();
  if (claudeNormalResponse.status !== 200 || claudeNormalText !== claudeSseBody) {
    throw new Error(`normal Claude request should pass through untouched, got ${claudeNormalResponse.status}: ${claudeNormalText}`);
  }
  if (upstreamRequests.length !== beforeClaudeNormal + 1) {
    throw new Error(`normal Claude request should make exactly one upstream request, got ${upstreamRequests.length - beforeClaudeNormal}`);
  }

  const restrictionFailoverAccounts = autoConfigRegistry.accounts
    .filter((account) => ["apikey-vsllm", "apikey-vsllm-2"].includes(account.account_key))
    .map((account) => JSON.parse(JSON.stringify(account)));
  const restrictionFailoverVsllm2 = restrictionFailoverAccounts.find((account) => account.account_key === "apikey-vsllm-2");
  restrictionFailoverVsllm2.api_spend = {
    ...(restrictionFailoverVsllm2.api_spend || {}),
    spend_usd: 10,
    exhausted: false
  };
  restrictionFailoverVsllm2.last_usage = {
    primary: { used_percent: 18, window_minutes: 480, resets_at: nowSeconds + 480 * 60 },
    secondary: { used_percent: 18, window_minutes: 480, resets_at: nowSeconds + 480 * 60 }
  };
  delete restrictionFailoverVsllm2.api_exhausted_reason;
  accounts.splice(0, accounts.length, ...restrictionFailoverAccounts);
  setActive("apikey-vsllm", true);
  claudeMessageFailures.push("api_key_ip_restriction");
  const beforeRestrictionFailover = upstreamRequests.length;
  const restrictionFailoverResponse = await proxyRawRequest(proxyPort, "/v1/messages", {
    model: "kimi-k3",
    max_tokens: 64,
    stream: true,
    messages: [{ role: "user", content: "Retry an account-specific API-key restriction." }]
  }, {
    "anthropic-version": "2023-06-01"
  });
  const restrictionFailoverText = await restrictionFailoverResponse.text();
  if (restrictionFailoverResponse.status !== 200 || restrictionFailoverText !== claudeSseBody) {
    throw new Error(`VSLLM API-key restriction should fail over transparently, got ${restrictionFailoverResponse.status}: ${restrictionFailoverText}`);
  }
  if (upstreamRequests.length !== beforeRestrictionFailover + 2) {
    throw new Error(`VSLLM API-key restriction should make one attempt per account, got ${upstreamRequests.length - beforeRestrictionFailover}`);
  }
  assertRequestAt(beforeRestrictionFailover, {
    label: "VSLLM API-key restriction first account",
    bearer: "vsllm-secret",
    acceptEncoding: "identity",
    expectedModel: "kimi-k3"
  });
  assertRequestAt(beforeRestrictionFailover + 1, {
    label: "VSLLM API-key restriction fallback account",
    bearer: "vsllm-2-secret",
    acceptEncoding: "identity",
    expectedModel: "kimi-k3"
  });
  const restrictionFailoverRegistry = readRegistry();
  if (restrictionFailoverRegistry.active_account_key !== "apikey-vsllm"
    || restrictionFailoverRegistry.accounts.some((account) => account.api_spend?.exhausted === true)) {
    throw new Error(`transient API-key restriction should not persist a switch or exhaust an account: ${JSON.stringify(restrictionFailoverRegistry)}`);
  }
  accounts.splice(0, accounts.length, ...autoConfigRegistry.accounts);
  setActive("apikey-vsllm");

  const beforeClaudeCountTokens = upstreamRequests.length;
  const countTokensResponse = await proxyRawRequest(proxyPort, "/v1/messages/count_tokens?beta=true", {
    model: "claude-fable-5-dd-5.4-korg[1m]",
    system: [{ type: "text", text: "Count locally." }],
    messages: [{ role: "user", content: "Do not spend an upstream request for this count." }]
  }, {
    "anthropic-version": "2023-06-01"
  });
  const countTokens = await countTokensResponse.json();
  if (countTokensResponse.status !== 200 || !Number.isFinite(countTokens.input_tokens) || countTokens.input_tokens <= 0) {
    throw new Error(`Claude Grok token count bridge returned an invalid response: ${JSON.stringify(countTokens)}`);
  }
  if (upstreamRequests.length !== beforeClaudeCountTokens) {
    throw new Error("Claude Grok token counting should be estimated locally without a VSLLM request");
  }

  const beforeClaudeNonStream = upstreamRequests.length;
  const claudeNonStreamResponse = await proxyRawRequest(proxyPort, "/v1/messages?beta=true", {
    model: "claude-fable-5-dd-5.4-korg[1m]",
    max_tokens: 256,
    stream: false,
    messages: [{ role: "user", content: "Reply with ok." }]
  }, {
    "anthropic-version": "2023-06-01"
  });
  const claudeNonStream = await claudeNonStreamResponse.json();
  if (claudeNonStreamResponse.status !== 200
    || claudeNonStream.type !== "message"
    || claudeNonStream.model !== "grok-4.5"
    || claudeNonStream.content?.[0]?.text !== "ok"
    || claudeNonStream.stop_reason !== "end_turn") {
    throw new Error(`Claude Grok non-stream response was not translated: ${JSON.stringify(claudeNonStream)}`);
  }
  if (upstreamRequests.length !== beforeClaudeNonStream + 1
    || upstreamRequests.at(-1)?.url !== "/v1/responses"
    || JSON.parse(upstreamRequests.at(-1).bodyText).stream !== false) {
    throw new Error("Claude Grok non-stream request did not use the Responses bridge");
  }

  const beforeClaudeModelsRequest = upstreamRequests.length;
  const modelsResponse = await fetch(`http://127.0.0.1:${proxyPort}/_codex-auth-advanced/${proxyGroupId(codexHome)}/v1/models?limit=1000`, {
    headers: {
      authorization: "Bearer local-claude-marker",
      "x-api-key": "local-claude-api-key-marker",
      "anthropic-version": "2023-06-01",
      "user-agent": "claude-cli/2.1.201"
    }
  });
  if (modelsResponse.status !== 200) {
    throw new Error(`Claude gateway model discovery failed with ${modelsResponse.status}: ${await modelsResponse.text()}`);
  }
  const models = await modelsResponse.json();
  const officialFableModel = models.data?.find((model) => model.id === "claude-fable-5");
  const officialSonnetModel = models.data?.find((model) => model.id === "claude-sonnet-5");
  const vsllmFableModel = models.data?.find((model) => model.id === vsllmClaudeGatewayModelId("claude-fable-5"));
  const fakeModel = models.data?.find((model) => model.id === vsllmClaudeGatewayModelId("claude-fake-5"));
  const kimiModel = models.data?.find((model) => model.id === vsllmClaudeGatewayModelId("kimi-k3", "[1m]"));
  const grokModel = models.data?.find((model) => model.id === vsllmClaudeGatewayModelId("grok-4.5", "[1m]"));
  const grok46Model = models.data?.find((model) => model.id === vsllmClaudeGatewayModelId("grok-4.6", "[1m]"));
  const gptModel = models.data?.find((model) => model.id === vsllmClaudeGatewayModelId("gpt-5.5"));
  if (models.has_more !== false
    || officialFableModel?.display_name !== "Claude Fable 5"
    || officialSonnetModel?.display_name !== "Claude Sonnet 5"
    || vsllmFableModel?.display_name !== "VSLLM: claude-fable-5"
    || fakeModel?.display_name !== "VSLLM: claude-fake-5"
    || kimiModel?.display_name !== "VSLLM: kimi-k3"
    || kimiModel?.max_input_tokens !== 1000000
    || grokModel?.display_name !== "VSLLM: grok-4.5"
    || grokModel?.max_input_tokens !== 1000000
    || grok46Model?.display_name !== "VSLLM: grok-4.6"
    || grok46Model?.max_input_tokens !== 1000000
    || gptModel?.display_name !== "VSLLM: gpt-5.5"
    || models.data?.length !== 8) {
    throw new Error(`Claude gateway model discovery did not merge official and VSLLM models: ${JSON.stringify(models)}`);
  }
  const discoveryRequests = upstreamRequests.slice(beforeClaudeModelsRequest);
  const vsllmDiscoveryRequest = discoveryRequests.find((request) => request.url === "/v1/models?limit=1000");
  const officialDiscoveryRequest = discoveryRequests.find((request) => request.url === `${officialAnthropicPathPrefix}/v1/models?limit=1000`);
  if (discoveryRequests.length !== 2
    || vsllmDiscoveryRequest?.authorization !== "Bearer vsllm-secret"
    || officialDiscoveryRequest?.authorization !== "Bearer local-claude-marker") {
    throw new Error(`Claude gateway discovery used incorrect provider authentication: ${JSON.stringify(discoveryRequests)}`);
  }

  const plainModelsResponse = await fetch(`http://127.0.0.1:${proxyPort}/_codex-auth-advanced/${proxyGroupId(codexHome)}/v1/models?limit=1000`, {
    headers: { authorization: "Bearer local-codex-marker" }
  });
  const plainModels = await plainModelsResponse.json();
  if (!plainModels.data?.some((model) => model.id === "gpt-5.5")
    || !plainModels.data?.some((model) => model.id === "kimi-k3")) {
    throw new Error(`non-Claude model discovery should remain pass-through: ${JSON.stringify(plainModels)}`);
  }
  const plainModelsRequest = upstreamRequests.at(-1);
  if (plainModelsRequest?.url !== "/v1/models?limit=1000"
    || plainModelsRequest?.authorization !== "Bearer vsllm-secret") {
    throw new Error(`non-Claude model discovery used incorrect upstream routing: ${JSON.stringify(plainModelsRequest)}`);
  }

  const expectedDefaultProxyUrl = `http://127.0.0.1:${proxyPort}/_codex-auth-advanced/${proxyGroupId(codexHome)}`;
  const expectedVsllm2ProxyUrl = `${expectedDefaultProxyUrl}/accounts/apikey-vsllm-2/v1`;
  const defaultProxyUrl = await runWrapper(["proxy", "url"]);
  if (defaultProxyUrl.stdout.trim() !== expectedDefaultProxyUrl) {
    throw new Error(`expected default proxy URL ${expectedDefaultProxyUrl}, got ${defaultProxyUrl.stdout}`);
  }
  const vsllm2ProxyUrl = await runWrapper(["proxy", "url", "vsllm-2"]);
  if (vsllm2ProxyUrl.stdout.trim() !== expectedVsllm2ProxyUrl) {
    throw new Error(`expected pinned vsllm-2 proxy URL ${expectedVsllm2ProxyUrl}, got ${vsllm2ProxyUrl.stdout}`);
  }
  const groupedVsllm2ProxyUrl = await runWrapper(["group", "default", "proxy", "url", "vsllm-2"]);
  if (groupedVsllm2ProxyUrl.stdout.trim() !== expectedVsllm2ProxyUrl) {
    throw new Error(`expected group-scoped pinned vsllm-2 proxy URL ${expectedVsllm2ProxyUrl}, got ${groupedVsllm2ProxyUrl.stdout}`);
  }
  const listedProxyUrls = await runWrapper(["proxy", "urls"]);
  if (!listedProxyUrls.stdout.includes(`vsllm-2\t${expectedVsllm2ProxyUrl}`)) {
    throw new Error(`expected proxy URL list to include vsllm-2 endpoint, got ${listedProxyUrls.stdout}`);
  }

  const openClawBody = {
    model: "gpt-5.6-terra",
    messages: [{ role: "user", content: "Hello from OpenClaw" }],
    stream: false,
    reasoning_effort: "ultra"
  };
  const openClawResponse = await proxyAccountRequest(proxyPort, "vsllm-2", "/chat/completions", openClawBody, {
    authorization: "Bearer local-openclaw-placeholder"
  });
  if (openClawResponse?.choices?.[0]?.message?.content !== "compacted message text") {
    throw new Error(`expected pinned OpenClaw chat-completions response, got ${JSON.stringify(openClawResponse)}`);
  }
  const pinnedOpenClawRequest = upstreamRequests.at(-1);
  if (!pinnedOpenClawRequest?.url.endsWith("/v1/chat/completions")) {
    throw new Error(`expected pinned OpenClaw request to target /v1/chat/completions, got ${pinnedOpenClawRequest?.url}`);
  }
  assertLatestRequest({
    label: "pinned vsllm-2 OpenClaw chat completion",
    bearer: "vsllm-2-secret",
    acceptEncoding: "identity",
    expectedModel: "gpt-5.6-terra",
    expectedReasoningEffort: "ultra"
  });

  const beforeUnknownPinnedAccount = upstreamRequests.length;
  const unknownPinnedAccount = await proxyAccountRawRequest(proxyPort, "missing-account", "/chat/completions", openClawBody);
  if (unknownPinnedAccount.status !== 404) {
    throw new Error(`expected unknown pinned account to return 404, got ${unknownPinnedAccount.status}: ${await unknownPinnedAccount.text()}`);
  }
  await unknownPinnedAccount.text();
  if (upstreamRequests.length !== beforeUnknownPinnedAccount) {
    throw new Error("unknown pinned account should not make an upstream request");
  }

  accounts.splice(0, accounts.length, ...autoConfigRegistry.accounts);
  setActive("apikey-vsllm", false);
  responseFailures.push("transient_usage_limit");
  const beforeTransientUsageLimit = upstreamRequests.length;
  await proxyRequest(proxyPort, "/responses", body);
  if (upstreamRequests.length !== beforeTransientUsageLimit + 2) {
    throw new Error(`expected transient VSLLM usage limit to retry once, got ${upstreamRequests.length - beforeTransientUsageLimit} upstream requests`);
  }
  assertRequestAt(beforeTransientUsageLimit, { label: "transient VSLLM usage limit first attempt", bearer: "vsllm-secret", acceptEncoding: "identity", expectEncryptedContent: true });
  assertRequestAt(beforeTransientUsageLimit + 1, { label: "transient VSLLM usage limit same-account retry", bearer: "vsllm-secret", acceptEncoding: "identity", expectEncryptedContent: true });
  const transientUsageLimitRegistry = readRegistry();
  const transientUsageLimitAccount = transientUsageLimitRegistry.accounts.find((account) => account.account_key === "apikey-vsllm");
  if (transientUsageLimitRegistry.active_account_key !== "apikey-vsllm" || transientUsageLimitAccount?.api_spend?.exhausted === true) {
    throw new Error(`transient VSLLM usage limit should not exhaust or switch the account, got ${JSON.stringify(transientUsageLimitRegistry)}`);
  }

  responseFailures.push("generic_service_unavailable");
  const beforeGenericUnavailable = upstreamRequests.length;
  const genericUnavailable = await proxyRawRequest(proxyPort, "/responses", body);
  if (genericUnavailable.status !== 503) {
    throw new Error(`expected unrelated service-unavailable response to remain 503, got ${genericUnavailable.status}: ${await genericUnavailable.text()}`);
  }
  await genericUnavailable.text();
  if (upstreamRequests.length !== beforeGenericUnavailable + 1) {
    throw new Error(`unrelated 503 should not retry the same account, got ${upstreamRequests.length - beforeGenericUnavailable} upstream requests`);
  }

  responseFailures.push("model_capacity_slow_down");
  const beforeTransientCapacity = upstreamRequests.length;
  await proxyRequest(proxyPort, "/responses", body);
  if (upstreamRequests.length !== beforeTransientCapacity + 2) {
    throw new Error(`expected transient model capacity to retry once before succeeding, got ${upstreamRequests.length - beforeTransientCapacity} upstream requests`);
  }
  assertRequestAt(beforeTransientCapacity, { label: "model capacity first attempt", bearer: "vsllm-secret", acceptEncoding: "identity", expectEncryptedContent: true });
  assertRequestAt(beforeTransientCapacity + 1, { label: "model capacity same-account retry", bearer: "vsllm-secret", acceptEncoding: "identity", expectEncryptedContent: true });
  const transientCapacityRegistry = readRegistry();
  const transientCapacityAccount = transientCapacityRegistry.accounts.find((account) => account.account_key === "apikey-vsllm");
  if (transientCapacityRegistry.active_account_key !== "apikey-vsllm" || transientCapacityAccount?.api_spend?.exhausted === true) {
    throw new Error(`model capacity should not exhaust or switch an account after a successful retry, got ${JSON.stringify(transientCapacityRegistry)}`);
  }

  setActive("apikey-vsllm", true);
  responseFailures.push("model_capacity", "model_capacity", "model_capacity", "model_capacity");
  const beforePersistentCapacity = upstreamRequests.length;
  await proxyRequest(proxyPort, "/responses", body);
  if (upstreamRequests.length !== beforePersistentCapacity + 5) {
    throw new Error(`expected persistent model capacity to use three same-account retries and then fail over, got ${upstreamRequests.length - beforePersistentCapacity} upstream requests`);
  }
  for (let offset = 0; offset < 4; offset += 1) {
    assertRequestAt(beforePersistentCapacity + offset, {
      label: `persistent model capacity attempt ${offset + 1}`,
      bearer: "vsllm-secret",
      acceptEncoding: "identity",
      expectEncryptedContent: true
    });
  }
  if (upstreamRequests[beforePersistentCapacity + 4]?.authorization === "Bearer vsllm-secret") {
    throw new Error("expected persistent model capacity to fall back to another usable account after bounded retries");
  }
  const persistentCapacityRegistry = readRegistry();
  const persistentCapacityAccount = persistentCapacityRegistry.accounts.find((account) => account.account_key === "apikey-vsllm");
  if (persistentCapacityAccount?.api_spend?.exhausted === true) {
    throw new Error(`persistent model capacity should not mark the account exhausted, got ${JSON.stringify(persistentCapacityAccount)}`);
  }

  setActive("apikey-vsllm", true);
  responseFailures.push("transient_usage_limit", "transient_usage_limit");
  const beforePersistentUsageLimit = upstreamRequests.length;
  await proxyRequest(proxyPort, "/responses", body);
  if (upstreamRequests.length !== beforePersistentUsageLimit + 3) {
    throw new Error(`expected persistent transient VSLLM usage limit to retry once and then use another account, got ${upstreamRequests.length - beforePersistentUsageLimit} upstream requests`);
  }
  assertRequestAt(beforePersistentUsageLimit, { label: "persistent VSLLM usage limit first attempt", bearer: "vsllm-secret", acceptEncoding: "identity", expectEncryptedContent: true });
  assertRequestAt(beforePersistentUsageLimit + 1, { label: "persistent VSLLM usage limit same-account retry", bearer: "vsllm-secret", acceptEncoding: "identity", expectEncryptedContent: true });
  if (upstreamRequests[beforePersistentUsageLimit + 2]?.authorization === "Bearer vsllm-secret") {
    throw new Error("expected persistent transient VSLLM usage limit to fall back to another usable account");
  }
  const persistentUsageLimitRegistry = readRegistry();
  const persistentUsageLimitAccount = persistentUsageLimitRegistry.accounts.find((account) => account.account_key === "apikey-vsllm");
  if (persistentUsageLimitAccount?.api_spend?.exhausted === true) {
    throw new Error(`persistent transient VSLLM usage limit should not mark the account exhausted, got ${JSON.stringify(persistentUsageLimitAccount)}`);
  }

  const cappedUsageLimitRegistry = JSON.parse(JSON.stringify(autoConfigRegistry));
  const cappedUsageLimitAccount = cappedUsageLimitRegistry.accounts.find((account) => account.account_key === "apikey-vsllm-2");
  cappedUsageLimitAccount.api_spend.exhausted = false;
  cappedUsageLimitAccount.api_spend.spend_usd = 55;
  cappedUsageLimitAccount.api_spend.limit_usd = 55;
  cappedUsageLimitAccount.last_usage.primary.used_percent = 100;
  accounts.splice(0, accounts.length, ...cappedUsageLimitRegistry.accounts);
  setActive("apikey-vsllm-2", true);
  responseFailures.push("transient_usage_limit");
  const beforeExhaustedUsageLimit = upstreamRequests.length;
  await proxyRequest(proxyPort, "/responses", body);
  if (upstreamRequests.length !== beforeExhaustedUsageLimit + 2) {
    throw new Error(`expected capped VSLLM usage limit to switch without same-account retry, got ${upstreamRequests.length - beforeExhaustedUsageLimit} upstream requests`);
  }
  assertRequestAt(beforeExhaustedUsageLimit, { label: "capped VSLLM usage limit first attempt", bearer: "vsllm-2-secret", acceptEncoding: "identity", expectEncryptedContent: true });
  if (upstreamRequests[beforeExhaustedUsageLimit + 1]?.authorization === "Bearer vsllm-2-secret") {
    throw new Error("expected capped VSLLM usage limit to switch to another usable account immediately");
  }
  const exhaustedUsageLimitRegistry = readRegistry();
  const exhaustedUsageLimitAccount = exhaustedUsageLimitRegistry.accounts.find((account) => account.account_key === "apikey-vsllm-2");
  if (exhaustedUsageLimitAccount?.api_spend?.exhausted !== true || exhaustedUsageLimitAccount?.api_exhausted_reason !== "rate_limit") {
    throw new Error(`expected capped VSLLM usage limit to mark the account exhausted, got ${JSON.stringify(exhaustedUsageLimitAccount)}`);
  }

  accounts.splice(0, accounts.length, ...autoConfigRegistry.accounts);
  setActive("apikey-vsllm", false);
  responseFailures.push("no_active_subscription");
  const beforePinnedNoActive = upstreamRequests.length;
  const pinnedNoActiveResponse = await proxyAccountRawRequest(proxyPort, "vsllm-2", "/responses", body);
  if (pinnedNoActiveResponse.status !== 402) {
    throw new Error(`expected pinned no-active-subscription response to pass through as 402, got ${pinnedNoActiveResponse.status}: ${await pinnedNoActiveResponse.text()}`);
  }
  await pinnedNoActiveResponse.text();
  if (upstreamRequests.length !== beforePinnedNoActive + 1) {
    throw new Error(`expected pinned no-active-subscription response not to retry, got ${upstreamRequests.length - beforePinnedNoActive} upstream requests`);
  }
  assertRequestAt(beforePinnedNoActive, { label: "pinned vsllm-2 no active subscription", bearer: "vsllm-2-secret", acceptEncoding: "identity", expectEncryptedContent: true });
  const pinnedNoActiveRegistry = readRegistry();
  if (pinnedNoActiveRegistry.active_account_key !== "apikey-vsllm") {
    throw new Error(`pinned account failure should not switch the active Codex account, got ${pinnedNoActiveRegistry.active_account_key}`);
  }

  setActive("apikey-vsllm", false);
  responseFailures.push("no_active_subscription");
  const beforeVsllmNoActive = upstreamRequests.length;
  await proxyRequest(proxyPort, "/responses", body);
  if (upstreamRequests.length !== beforeVsllmNoActive + 2) {
    throw new Error(`expected no-active-subscription response to fail over and retry, got ${upstreamRequests.length - beforeVsllmNoActive} upstream requests`);
  }
  assertRequestAt(beforeVsllmNoActive, { label: "vsllm no active subscription first attempt", bearer: "vsllm-secret", acceptEncoding: "identity", expectEncryptedContent: true });
  const vsllmNoActiveRetry = upstreamRequests[beforeVsllmNoActive + 1];
  if (vsllmNoActiveRetry?.authorization === "Bearer vsllm-secret") {
    throw new Error("expected no-active-subscription retry to switch away from vsllm");
  }
  const noActiveRegistry = readRegistry();
  if (noActiveRegistry.auto_switch?.enabled !== false) {
    throw new Error(`expected hard proxy failover not to enable scheduled auto-switch, got ${JSON.stringify(noActiveRegistry.auto_switch)}`);
  }
  if (noActiveRegistry.active_account_key === "apikey-vsllm") {
    throw new Error("expected hard proxy failover to switch away from vsllm even with scheduled auto-switch disabled");
  }
  const exhaustedVsllm = noActiveRegistry.accounts.find((account) => account.account_key === "apikey-vsllm");
  if (exhaustedVsllm?.api_spend?.exhausted !== true || exhaustedVsllm?.api_exhausted_reason !== "no_active_subscription") {
    throw new Error(`expected vsllm to be marked exhausted by no-active-subscription text, got ${JSON.stringify(exhaustedVsllm)}`);
  }

  const usableVsllm2Registry = JSON.parse(JSON.stringify(autoConfigRegistry));
  const usableVsllm2 = usableVsllm2Registry.accounts.find((account) => account.account_key === "apikey-vsllm-2");
  usableVsllm2.api_spend_limit_usd = 55;
  usableVsllm2.api_spend_window_minutes = 480;
  usableVsllm2.api_spend = {
    spend_usd: 10,
    total_spend_usd: 106.242272,
    limit_usd: 55,
    remaining_usd: 45,
    window_minutes: 480,
    status: 200,
    exhausted: false,
    checked_at: nowSeconds
  };
  usableVsllm2.api_spend_window = {
    window_minutes: 480,
    total_spend_usd: 106.242272,
    samples: [{ at: nowSeconds, spend_usd: 10, total_spend_usd: 106.242272 }],
    updated_at: nowSeconds
  };
  usableVsllm2.last_usage = {
    primary: { used_percent: 18, window_minutes: 480, resets_at: nowSeconds + 480 * 60 },
    secondary: { used_percent: 18, window_minutes: 480, resets_at: nowSeconds + 480 * 60 },
    credits: { has_credits: true, unlimited: false, balance: "45" },
    plan_type: "apikey"
  };
  accounts.splice(0, accounts.length, ...usableVsllm2Registry.accounts);
  setActive("apikey-vsllm-2", false);
  responseFailures.push("no_active_subscription");
  const beforeUsableVsllm2NoActive = upstreamRequests.length;
  await proxyRequest(proxyPort, "/responses", body);
  if (upstreamRequests.length !== beforeUsableVsllm2NoActive + 2) {
    throw new Error(`expected usable vsllm-2 no-active-subscription response to fail over and retry, got ${upstreamRequests.length - beforeUsableVsllm2NoActive} upstream requests`);
  }
  const usableNoActiveRegistry = readRegistry();
  if (usableNoActiveRegistry.active_account_key === "apikey-vsllm-2") {
    throw new Error("expected usable vsllm-2 to switch after a direct no-active-subscription response");
  }
  const exhaustedUsableVsllm2 = usableNoActiveRegistry.accounts.find((account) => account.account_key === "apikey-vsllm-2");
  if (exhaustedUsableVsllm2?.api_spend?.exhausted !== true || exhaustedUsableVsllm2?.api_exhausted_reason !== "no_active_subscription") {
    throw new Error(`expected usable vsllm-2 to be marked exhausted by no-active-subscription text, got ${JSON.stringify(exhaustedUsableVsllm2)}`);
  }
  accounts.splice(0, accounts.length, ...autoConfigRegistry.accounts);

  setActive("apikey-tcdmx");
  await proxyRequest(proxyPort, "/responses", aliasedModelBody);
  assertLatestRequest({
    label: "tcdmx responses model untouched",
    bearer: "tcdmx-secret",
    acceptEncoding: "identity",
    expectEncryptedContent: true,
    expectedModel: "gpt-5.2"
  });
  await proxyRequest(proxyPort, "/responses", {
    ...body,
    model: "gpt-5.6-terra"
  });
  assertLatestRequest({
    label: "tcdmx gpt-5.6 responses model untouched",
    bearer: "tcdmx-secret",
    acceptEncoding: "identity",
    expectEncryptedContent: true,
    expectedModel: "gpt-5.6-terra"
  });
  const tcdmxClaudeResponse = await proxyRawRequest(proxyPort, "/v1/messages", {
    model: vsllmClaudeGatewayModelId("claude-fable-5"),
    max_tokens: 64,
    stream: true,
    messages: [{ role: "user", content: "test" }]
  }, {
    "anthropic-version": "2023-06-01"
  });
  await tcdmxClaudeResponse.text();
  assertLatestRequest({
    label: "tcdmx VSLLM Claude Fable model",
    bearer: "tcdmx-secret",
    acceptEncoding: "identity",
    expectedModel: "claude-fable-5"
  });
  const compactRes2 = await proxyRequest(proxyPort, "/responses/compact", body);
  const latestTcdmxReq = upstreamRequests.at(-1);
  if (!latestTcdmxReq || !latestTcdmxReq.url.endsWith("/responses/compact")) {
    throw new Error(`expected tcdmx to use native compact endpoint, got url: ${latestTcdmxReq?.url}`);
  }
  assertLatestRequest({ label: "tcdmx native compact", bearer: "tcdmx-secret", acceptEncoding: "identity", expectEncryptedContent: true });
  assertCompactResponseTextContent("tcdmx native compact response", compactRes2);

  await proxyRequest(proxyPort, "/responses", body);
  assertLatestRequest({ label: "tcdmx responses", bearer: "tcdmx-secret", acceptEncoding: "identity", expectEncryptedContent: true });

  compactFailures.push("invalid_encrypted_content");
  const beforeTcdmxFallback = upstreamRequests.length;
  await proxyRequest(proxyPort, "/responses/compact", body);
  if (upstreamRequests.length !== beforeTcdmxFallback + 2) {
    throw new Error(`expected tcdmx compact fallback to make 2 upstream requests, got ${upstreamRequests.length - beforeTcdmxFallback}`);
  }
  assertRequestAt(beforeTcdmxFallback, { label: "tcdmx compact first attempt", bearer: "tcdmx-secret", acceptEncoding: "identity", expectEncryptedContent: true });
  assertRequestAt(beforeTcdmxFallback + 1, { label: "tcdmx compact plaintext fallback", bearer: "tcdmx-secret", acceptEncoding: "identity", expectEncryptedContent: false, expectReasoning: false, expectPlaintextCompactOnly: true });

  setActive("apikey-codex-everywhere");
  const compactRes3 = await proxyRequest(proxyPort, "/responses/compact", body);
  assertLatestRequest({ label: "codex-everywhere native compact", bearer: "codex-everywhere-secret", acceptEncoding: "identity", expectEncryptedContent: true });
  assertCompactResponseTextContent("codex-everywhere native compact response", compactRes3);

  compactFailures.push("missing_encrypted_content");
  const beforeEverywhereFallback = upstreamRequests.length;
  await proxyRequest(proxyPort, "/responses/compact", body);
  if (upstreamRequests.length !== beforeEverywhereFallback + 2) {
    throw new Error(`expected codex-everywhere compact fallback to make 2 upstream requests, got ${upstreamRequests.length - beforeEverywhereFallback}`);
  }
  assertRequestAt(beforeEverywhereFallback, { label: "codex-everywhere compact first attempt", bearer: "codex-everywhere-secret", acceptEncoding: "identity", expectEncryptedContent: true });
  assertRequestAt(beforeEverywhereFallback + 1, { label: "codex-everywhere compact plaintext fallback", bearer: "codex-everywhere-secret", acceptEncoding: "identity", expectEncryptedContent: false, expectReasoning: false, expectPlaintextCompactOnly: true });

  const beforeUpgradeCount = upstreamRequests.length;
  const upgradeResponse = await proxyUpgrade(proxyPort, "/responses");
  if (!upgradeResponse.startsWith("HTTP/1.1 426 ")) {
    throw new Error(`expected API WebSocket upgrade to return 426, got ${upgradeResponse.split(/\r?\n/, 1)[0]}`);
  }
  if (upstreamRequests.length !== beforeUpgradeCount) {
    throw new Error("API WebSocket upgrade should not be forwarded upstream");
  }

  setActive("apikey-openai");
  await proxyRequest(proxyPort, "/responses/compact", body);
  assertLatestRequest({ label: "openai compact", bearer: "openai-secret", expectEncryptedContent: true });

  await proxyRequest(proxyPort, "/responses", body);
  assertLatestRequest({ label: "openai responses", bearer: "openai-secret", expectEncryptedContent: true });

  setActive("chatgpt-business");
  await proxyRequest(proxyPort, "/responses/compact", body);
  assertLatestRequest({ label: "business compact", bearer: "business-token", expectEncryptedContent: true });

  await proxyRequest(proxyPort, "/responses", body);
  assertLatestRequest({ label: "business responses", bearer: "business-token", expectEncryptedContent: true });

  const headerFailoverAccounts = autoConfigRegistry.accounts
    .filter((account) => ["apikey-vsllm", "apikey-vsllm-2"].includes(account.account_key))
    .map((account) => JSON.parse(JSON.stringify(account)));
  const headerFailoverVsllm2 = headerFailoverAccounts.find((account) => account.account_key === "apikey-vsllm-2");
  headerFailoverVsllm2.api_spend = {
    ...(headerFailoverVsllm2.api_spend || {}),
    spend_usd: 10,
    exhausted: false
  };
  headerFailoverVsllm2.last_usage = {
    primary: { used_percent: 18, window_minutes: 480, resets_at: nowSeconds + 480 * 60 },
    secondary: { used_percent: 18, window_minutes: 480, resets_at: nowSeconds + 480 * 60 }
  };
  delete headerFailoverVsllm2.api_exhausted_reason;
  accounts.splice(0, accounts.length, ...headerFailoverAccounts);
  setActive("apikey-vsllm", true);
  responseFailures.push("network_error");
  const beforeNetworkFailover = upstreamRequests.length;
  const networkFailoverResponse = await proxyRequest(proxyPort, "/responses", { ...body, stream: true });
  if (networkFailoverResponse?.type !== "response.completed") {
    throw new Error(`network failure should fail over to the second account, got ${JSON.stringify(networkFailoverResponse)}`);
  }
  if (upstreamRequests.length !== beforeNetworkFailover + 2) {
    throw new Error(`network failure should make one attempt per account, got ${upstreamRequests.length - beforeNetworkFailover}`);
  }
  assertRequestAt(beforeNetworkFailover, {
    label: "network failure first account",
    bearer: "vsllm-secret",
    acceptEncoding: "identity",
    expectEncryptedContent: true
  });
  assertRequestAt(beforeNetworkFailover + 1, {
    label: "network failure fallback account",
    bearer: "vsllm-2-secret",
    acceptEncoding: "identity",
    expectEncryptedContent: true
  });

  responseFailures.push("stall_headers");
  const beforeHeaderFailover = upstreamRequests.length;
  const headerCloseCountBeforeFailover = headerStallConnectionCloseCount;
  const headerFailoverStart = Date.now();
  const headerFailoverResponse = await proxyRequest(proxyPort, "/responses", { ...body, stream: true });
  const headerFailoverElapsedMs = Date.now() - headerFailoverStart;
  if (headerFailoverResponse?.type !== "response.completed") {
    throw new Error(`header stall should fail over to the second account, got ${JSON.stringify(headerFailoverResponse)}`);
  }
  if (upstreamRequests.length !== beforeHeaderFailover + 2) {
    throw new Error(`header stall should make one attempt per account, got ${upstreamRequests.length - beforeHeaderFailover}`);
  }
  assertRequestAt(beforeHeaderFailover, {
    label: "header stall first account",
    bearer: "vsllm-secret",
    acceptEncoding: "identity",
    expectEncryptedContent: true
  });
  assertRequestAt(beforeHeaderFailover + 1, {
    label: "header stall fallback account",
    bearer: "vsllm-2-secret",
    acceptEncoding: "identity",
    expectEncryptedContent: true
  });
  if (headerFailoverElapsedMs < 350 || headerFailoverElapsedMs > 5000) {
    throw new Error(`expected header-stall failover after the ~400ms watchdog, took ${headerFailoverElapsedMs}ms`);
  }
  for (let i = 0; i < 20 && headerStallConnectionCloseCount === headerCloseCountBeforeFailover; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (headerStallConnectionCloseCount <= headerCloseCountBeforeFailover) {
    throw new Error("header watchdog should abort the stalled upstream connection before retrying");
  }
  if (proxy.exitCode !== null || !(await readProxyHealth(proxyPort))) {
    throw new Error("proxy should remain healthy after aborting and failing over a header-stalled request");
  }

  accounts.splice(0, accounts.length, ...autoConfigRegistry.accounts);
  setActive("apikey-openai");

  responseFailures.push("stall_stream");
  const stallStart = Date.now();
  const stallResponse = await proxyRawRequest(proxyPort, "/responses", { ...body, stream: true });
  const stallBody = await stallResponse.text();
  const stallElapsedMs = Date.now() - stallStart;
  if (!stallBody.includes("codex_auth_advanced_stream_stall")) {
    throw new Error(`expected the stall watchdog to emit an SSE error event, got: ${stallBody.slice(0, 300)}`);
  }
  if (!stallBody.includes("event: error")) {
    throw new Error(`expected the stall watchdog payload as an SSE error event, got: ${stallBody.slice(0, 300)}`);
  }
  if (stallResponse.status !== 200 && stallResponse.status !== 502) {
    throw new Error(`expected the stalled stream to surface as 200 (SSE error event) or 502, got ${stallResponse.status}`);
  }
  if (stallElapsedMs < 350 || stallElapsedMs > 5000) {
    throw new Error(`expected the stall watchdog to fail fast (~400ms), took ${stallElapsedMs}ms`);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));

  responseFailures.push("stall_headers");
  const headerStallStart = Date.now();
  const headerStallResponse = await proxyRawRequest(proxyPort, "/responses", { ...body, stream: true });
  const headerStallElapsedMs = Date.now() - headerStallStart;
  if (headerStallResponse.status !== 524) {
    throw new Error(`expected a header stall to surface as 524 after the headers watchdog, got ${headerStallResponse.status}: ${await headerStallResponse.text()}`);
  }
  const headerStallBody = await headerStallResponse.text();
  if (!headerStallBody.includes("codex_auth_advanced_stream_stall")) {
    throw new Error(`expected the headers stall payload to carry the stall type, got: ${headerStallBody.slice(0, 300)}`);
  }
  if (headerStallElapsedMs < 350 || headerStallElapsedMs > 5000) {
    throw new Error(`expected the header stall to fail fast (~400ms), took ${headerStallElapsedMs}ms`);
  }
  await new Promise((resolve) => setTimeout(resolve, 350));
  if (proxy.exitCode !== null || !(await readProxyHealth(proxyPort))) {
    throw new Error("proxy should remain healthy after the stalled upstream closes after the 524 response");
  }

  const healthyAfterStall = await proxyRequest(proxyPort, "/responses", body);
  if (healthyAfterStall?.type !== "response.completed") {
    throw new Error(`expected the stream after a stall to behave normally, got ${JSON.stringify(healthyAfterStall)}`);
  }

  responseFailures.push("delayed_completed");
  const beforeGracefulRestartRequest = upstreamRequests.length;
  const inFlightResponse = proxyRequest(proxyPort, "/responses", body);
  for (let i = 0; i < 50 && upstreamRequests.length === beforeGracefulRestartRequest; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (upstreamRequests.length !== beforeGracefulRestartRequest + 1) {
    throw new Error("expected an upstream request to be active before requesting graceful restart");
  }

  const restartResponse = await fetch(`http://127.0.0.1:${proxyPort}/_codex-auth-advanced/restart`, { method: "POST" });
  if (restartResponse.status !== 202) {
    throw new Error(`expected graceful restart request to return 202, got ${restartResponse.status}: ${await restartResponse.text()}`);
  }
  const restartPayload = await restartResponse.json();
  if (restartPayload.restart_requested !== true || restartPayload.active_requests < 1) {
    throw new Error(`expected graceful restart to preserve the active response, got ${JSON.stringify(restartPayload)}`);
  }

  const rejectedDuringRestart = await proxyRawRequest(proxyPort, "/responses", body);
  if (rejectedDuringRestart.status !== 503) {
    throw new Error(`expected new requests to be rejected while the proxy drains, got ${rejectedDuringRestart.status}: ${await rejectedDuringRestart.text()}`);
  }
  await rejectedDuringRestart.text();

  const completedDuringRestart = await inFlightResponse;
  if (completedDuringRestart?.type !== "response.completed") {
    throw new Error(`expected the in-flight response to finish before restart, got ${JSON.stringify(completedDuringRestart)}`);
  }
  await waitForChildExit(proxy);

  console.log("provider proxy compact sanitizer ok");
} finally {
  if (proxy.exitCode === null && proxy.signalCode === null) {
    proxy.kill("SIGTERM");
    await new Promise((resolve) => {
      proxy.once("exit", resolve);
      setTimeout(resolve, 1000);
    });
  }
  upstream.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
