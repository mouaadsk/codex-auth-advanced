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
  if (req.method === "GET" && req.url.endsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
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

async function waitForHealth(port) {
  const url = `http://127.0.0.1:${port}/_codex-auth-advanced/health`;
  for (let i = 0; i < 50; i += 1) {
    try {
      const response = await fetch(url);
      if (response.status === 200) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("proxy did not become healthy");
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

async function proxyRawRequest(port, suffix, body) {
  return fetch(`http://127.0.0.1:${port}/_codex-auth-advanced/${proxyGroupId(codexHome)}${suffix}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
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
        CODEX_HOME: codexHome
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
    CODEX_AUTH_ADVANCED_CHATGPT_BASE_URL: upstreamBaseUrl
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

  setActive("apikey-vsllm");
  const compactRes1 = await proxyRequest(proxyPort, "/responses/compact", body);
  const latestReq = upstreamRequests.at(-1);
  if (!latestReq || !latestReq.url.endsWith("/responses/compact")) {
    throw new Error(`expected vsllm to use native compact endpoint, got url: ${latestReq?.url}`);
  }
  assertLatestRequest({ label: "vsllm native compact", bearer: "vsllm-secret", acceptEncoding: "identity", expectEncryptedContent: true });
  assertCompactResponseTextContent("vsllm native compact response", compactRes1);

  compactFailures.push("not_found");
  const beforeVsllmFallback = upstreamRequests.length;
  const compactRes1Fallback = await proxyRequest(proxyPort, "/responses/compact", body);
  if (upstreamRequests.length !== beforeVsllmFallback + 2) {
    throw new Error(`expected vsllm compact fallback to make 2 upstream requests, got ${upstreamRequests.length - beforeVsllmFallback}`);
  }
  assertRequestAt(beforeVsllmFallback, { label: "vsllm compact first attempt", bearer: "vsllm-secret", acceptEncoding: "identity", expectEncryptedContent: true });
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
  assertLatestRequest({ label: "vsllm compact fallback", bearer: "vsllm-secret", acceptEncoding: "identity", expectEncryptedContent: false });
  assertCompactResponseTextContent("vsllm compact fallback response", compactRes1Fallback);

  setActive("apikey-vsllm", true);
  responseFailures.push("no_active_subscription");
  const beforeVsllmNoActive = upstreamRequests.length;
  const noActiveResponse = await proxyRawRequest(proxyPort, "/responses", body);
  if (noActiveResponse.status !== 402) {
    throw new Error(`expected no-active-subscription response to pass through as 402, got ${noActiveResponse.status}: ${await noActiveResponse.text()}`);
  }
  await noActiveResponse.text();
  if (upstreamRequests.length !== beforeVsllmNoActive + 1) {
    throw new Error(`expected no-active-subscription response not to retry, got ${upstreamRequests.length - beforeVsllmNoActive} upstream requests`);
  }
  assertRequestAt(beforeVsllmNoActive, { label: "vsllm no active subscription passthrough", bearer: "vsllm-secret", acceptEncoding: "identity", expectEncryptedContent: true });
  const noActiveRegistry = readRegistry();
  if (noActiveRegistry.active_account_key !== "apikey-vsllm") {
    throw new Error(`expected active account to remain vsllm, got ${noActiveRegistry.active_account_key}`);
  }
  const notExhaustedVsllm = noActiveRegistry.accounts.find((account) => account.account_key === "apikey-vsllm");
  if (notExhaustedVsllm?.api_spend?.exhausted === true) {
    throw new Error(`expected vsllm not to be marked exhausted by no-active-subscription text, got ${JSON.stringify(notExhaustedVsllm)}`);
  }
  const stillExhaustedVsllm2 = noActiveRegistry.accounts.find((account) => account.account_key === "apikey-vsllm-2");
  if (stillExhaustedVsllm2?.api_spend?.exhausted !== true) {
    throw new Error(`expected vsllm-2 to remain exhausted, got ${JSON.stringify(stillExhaustedVsllm2)}`);
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
  setActive("apikey-vsllm-2", true);
  responseFailures.push("no_active_subscription");
  const beforeUsableVsllm2NoActive = upstreamRequests.length;
  const usableNoActiveResponse = await proxyRawRequest(proxyPort, "/responses", body);
  if (usableNoActiveResponse.status !== 402) {
    throw new Error(`expected usable vsllm-2 no-active-subscription response to pass through as 402, got ${usableNoActiveResponse.status}: ${await usableNoActiveResponse.text()}`);
  }
  await usableNoActiveResponse.text();
  if (upstreamRequests.length !== beforeUsableVsllm2NoActive + 1) {
    throw new Error(`expected usable vsllm-2 no-active-subscription response not to retry, got ${upstreamRequests.length - beforeUsableVsllm2NoActive} upstream requests`);
  }
  const usableNoActiveRegistry = readRegistry();
  if (usableNoActiveRegistry.active_account_key !== "apikey-vsllm-2") {
    throw new Error(`expected active account to remain usable vsllm-2, got ${usableNoActiveRegistry.active_account_key}`);
  }
  const stillUsableVsllm2 = usableNoActiveRegistry.accounts.find((account) => account.account_key === "apikey-vsllm-2");
  if (stillUsableVsllm2?.api_spend?.exhausted === true || stillUsableVsllm2?.api_exhausted_reason) {
    throw new Error(`expected usable vsllm-2 not to be exhausted by no-active-subscription text, got ${JSON.stringify(stillUsableVsllm2)}`);
  }
  accounts.splice(0, accounts.length, ...autoConfigRegistry.accounts);

  setActive("apikey-vsllm-2", true);
  responseFailures.push("no_active_subscription");
  const beforeVsllm2NoActive = upstreamRequests.length;
  await proxyRequest(proxyPort, "/responses", body);
  if (upstreamRequests.length !== beforeVsllm2NoActive + 2) {
    throw new Error(`expected explicitly capped vsllm-2 no-active-subscription response to retry, got ${upstreamRequests.length - beforeVsllm2NoActive} upstream requests`);
  }
  assertRequestAt(beforeVsllm2NoActive, { label: "vsllm-2 no active subscription first attempt", bearer: "vsllm-2-secret", acceptEncoding: "identity", expectEncryptedContent: true });
  const vsllm2Retry = upstreamRequests[beforeVsllm2NoActive + 1];
  if (vsllm2Retry?.authorization === "Bearer vsllm-2-secret") {
    throw new Error("expected vsllm-2 no-active-subscription retry to switch away from vsllm-2");
  }
  const vsllm2NoActiveRegistry = readRegistry();
  if (vsllm2NoActiveRegistry.active_account_key === "apikey-vsllm-2") {
    throw new Error("expected active account to switch away from exhausted vsllm-2");
  }
  const noActiveExhaustedVsllm2 = vsllm2NoActiveRegistry.accounts.find((account) => account.account_key === "apikey-vsllm-2");
  if (noActiveExhaustedVsllm2?.api_spend?.exhausted !== true || noActiveExhaustedVsllm2?.api_exhausted_reason !== "no_active_subscription") {
    throw new Error(`expected vsllm-2 to be marked exhausted by no-active-subscription text, got ${JSON.stringify(noActiveExhaustedVsllm2)}`);
  }

  setActive("apikey-tcdmx");
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

  console.log("provider proxy compact sanitizer ok");
} finally {
  proxy.kill("SIGTERM");
  await new Promise((resolve) => {
    proxy.once("exit", resolve);
    setTimeout(resolve, 1000);
  });
  upstream.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
