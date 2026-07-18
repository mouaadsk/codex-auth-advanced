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
fs.mkdirSync(accountsDir, { recursive: true, mode: 0o700 });

const upstreamRequests = [];
const compactFailures = [];
const responseFailures = [];
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
const usageTotalsByBearer = new Map([
  ["Bearer vsllm-secret", 28.097534],
  ["Bearer vsllm-2-secret", 96.242272]
]);
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
  if (req.method === "GET" && req.url.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      data: [
        { id: "claude-fable-5", display_name: "Claude Fable 5" },
        { id: "claude-fake-5", display_name: "Claude Fake 5" },
        { id: "kimi-k3", display_name: "Kimi K3" },
        { id: "kimi-k3[1m]", display_name: "Kimi K3 1M" },
        { id: "grok-4.5", display_name: "Grok 4.5" },
        { id: "gpt-5.5", display_name: "GPT 5.5" }
      ]
    }));
    return;
  }
  if (req.method === "POST" && req.url.startsWith("/v1/messages")) {
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
        CODEX_HOME: codexHome,
        CODEX_AUTH_ADVANCED_PROXY_PORT: String(proxyPort)
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
    CODEX_AUTH_ADVANCED_MODEL_CAPACITY_RETRY_BASE_MS: "5"
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
  const vsllmPro20xModelAliases = [
    ["gpt-5.6-sol", "gpt-5.6-sol-pro20x", "ultra"],
    ["gpt-5.6-terra", "gpt-5.6-terra-pro20x", "ultra"],
    ["gpt-5.6-luna", "gpt-5.6-luna-pro20x", "max"]
  ];

  setActive("apikey-vsllm");
  await proxyRequest(proxyPort, "/responses", aliasedModelBody);
  assertLatestRequest({
    label: "vsllm responses model alias",
    bearer: "vsllm-secret",
    acceptEncoding: "identity",
    expectEncryptedContent: true,
    expectedModel: "gpt-5.5-pro20x",
    expectedReasoningEffort: "xhigh"
  });
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
    expectedModel: "gpt-5.5-pro20x-openai-compact"
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
    expectedModel: "gpt-5.5-pro20x-openai-compact"
  });
  assertRequestAt(beforeAliasedVsllmFallback + 1, {
    label: "vsllm compact alias fallback",
    bearer: "vsllm-secret",
    acceptEncoding: "identity",
    expectEncryptedContent: false,
    expectedModel: "gpt-5.5-pro20x-openai-compact"
  });

  for (const [inputModel, expectedModel, expectedReasoningEffort] of vsllmPro20xModelAliases) {
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
      expectedModel,
      expectedReasoningEffort
    });
  }

  const claudeModelRoutes = [
    { inputModel: "fable", expectedModel: "claude-fake-5" },
    { inputModel: "fable-5", expectedModel: "claude-fake-5" },
    { inputModel: "claude-fable-5", expectedModel: "claude-fake-5" },
    { inputModel: "grok-4.5[1m]", expectedModel: "grok-4.5" },
    { inputModel: "kimi-k3[1m]", expectedModel: "kimi-k3[1m]" },
    { inputModel: "claude-fable-5-dd-3k-imik", expectedModel: "kimi-k3" },
    { inputModel: "claude-fable-5-dd-5.4-korg", expectedModel: "grok-4.5" },
    { inputModel: "claude-fable-5-dd-5.4-korg[1m]", expectedModel: "grok-4.5" }
  ];
  for (const { inputModel, expectedModel } of claudeModelRoutes) {
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
    if (responseText !== claudeSseBody) {
      throw new Error(`Claude ${inputModel} SSE response was modified:\n${responseText}`);
    }
    if (responseText.includes("encrypted_content")) {
      throw new Error(`Claude ${inputModel} SSE response must not receive OpenAI encrypted_content fields`);
    }
    if (upstreamRequests.length !== beforeClaudeRequest + 1) {
      throw new Error(`Claude ${inputModel} request should make one upstream request`);
    }
    const claudeRequest = upstreamRequests.at(-1);
    if (claudeRequest.url !== "/v1/messages?beta=true") {
      throw new Error(`Claude ${inputModel} request used the wrong upstream path: ${claudeRequest.url}`);
    }
    if (claudeRequest.authorization !== "Bearer vsllm-secret" || claudeRequest.apiKey !== undefined) {
      throw new Error(`Claude ${inputModel} request did not replace local credentials with the active account key`);
    }
    if (claudeRequest.anthropicVersion !== "2023-06-01"
      || claudeRequest.anthropicBeta !== "test-beta-2026-07-17"
      || claudeRequest.claudeSessionId !== "session-test"
      || claudeRequest.claudeAgentId !== "agent-test") {
      throw new Error(`Claude ${inputModel} request headers were not preserved: ${JSON.stringify(claudeRequest)}`);
    }
    const claudeBody = JSON.parse(claudeRequest.bodyText);
    if (claudeBody.model !== expectedModel) {
      throw new Error(`Claude ${inputModel} should map to ${expectedModel}, got ${claudeBody.model}`);
    }
    if (claudeBody.system?.[0]?.text !== "Keep the response short." || claudeBody.messages?.[0]?.content !== "Reply with ok.") {
      throw new Error(`Claude ${inputModel} request body fields were not preserved`);
    }
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
  const kimiModel = models.data?.find((model) => model.id === "claude-fable-5-dd-3k-imik");
  const grokModel = models.data?.find((model) => model.id === "claude-fable-5-dd-5.4-korg");
  if (models.has_more !== false
    || kimiModel?.display_name !== "kimi-k3"
    || grokModel?.display_name !== "grok-4.5"
    || models.data?.length !== 2) {
    throw new Error(`Claude gateway model discovery did not expose the independent VSLLM models: ${JSON.stringify(models)}`);
  }
  if (upstreamRequests.length !== beforeClaudeModelsRequest) {
    throw new Error("Claude gateway model discovery should be served locally without waiting for VSLLM");
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
    expectedModel: "gpt-5.6-terra-pro20x",
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
    model: "claude-fable-5",
    max_tokens: 64,
    stream: true,
    messages: [{ role: "user", content: "test" }]
  }, {
    "anthropic-version": "2023-06-01"
  });
  await tcdmxClaudeResponse.text();
  assertLatestRequest({
    label: "tcdmx Claude model untouched",
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

  setActive("apikey-openai");
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
