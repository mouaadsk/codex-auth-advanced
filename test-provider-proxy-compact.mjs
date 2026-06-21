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
  if (compactFailure) {
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
      type: "response.compaction",
      messages: [
        { type: "message", role: "assistant", content: "compacted message text" }
      ]
    }));
  } else if (req.url.endsWith("/chat/completions")) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: " + JSON.stringify({
      choices: [
        {
          delta: {
            content: "compacted message text"
          }
        }
      ]
    }) + "\n");
    res.write("data: [DONE]\n");
    res.end();
  } else {
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

function writeAccount({ key, alias, template, baseUrl, authMode = "apikey" }) {
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
  return {
    account_key: key,
    alias,
    email: alias,
    auth_mode: authMode,
    api_template: template
  };
}

async function proxyRequest(port, suffix, body) {
  const response = await fetch(`http://127.0.0.1:${port}/_codex-auth-advanced/${proxyGroupId(codexHome)}${suffix}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
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

const upstreamPort = await listen(upstream);
const upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}`;
const accounts = [
  writeAccount({ key: "apikey-codex-everywhere", alias: "codex-everywhere", template: null, baseUrl: upstreamBaseUrl }),
  writeAccount({ key: "apikey-tcdmx", alias: "tcdmx", template: null, baseUrl: upstreamBaseUrl }),
  writeAccount({ key: "apikey-openai", alias: "openai", template: "openai", baseUrl: upstreamBaseUrl }),
  writeAccount({ key: "chatgpt-business", alias: "business", template: null, baseUrl: upstreamBaseUrl, authMode: "chatgpt" })
];

function setActive(accountKey) {
  fs.writeFileSync(
    path.join(accountsDir, "registry.json"),
    JSON.stringify({ active_account_key: accountKey, auto_switch: { enabled: false }, accounts }, null, 2),
    { mode: 0o600 }
  );
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

  setActive("apikey-tcdmx");
  const compactRes1 = await proxyRequest(proxyPort, "/responses/compact", body);
  const latestReq = upstreamRequests.at(-1);
  if (!latestReq || !latestReq.url.endsWith("/chat/completions")) {
    throw new Error(`expected tcdmx to run local compaction fallback on completions, got url: ${latestReq?.url}`);
  }
  assertLatestRequest({ label: "tcdmx local compaction fallback", bearer: "tcdmx-secret", acceptEncoding: "identity", expectEncryptedContent: false });
  if (!compactRes1.messages || compactRes1.messages[0].encrypted_content !== "" || compactRes1.messages[0].content[0].text !== "compacted message text") {
    throw new Error(`expected local compaction summary in tcdmx response, got: ${JSON.stringify(compactRes1)}`);
  }

  await proxyRequest(proxyPort, "/responses", body);
  assertLatestRequest({ label: "tcdmx responses", bearer: "tcdmx-secret", acceptEncoding: "identity", expectEncryptedContent: true });

  setActive("apikey-codex-everywhere");
  const compactRes3 = await proxyRequest(proxyPort, "/responses/compact", body);
  assertLatestRequest({ label: "codex-everywhere native compact", bearer: "codex-everywhere-secret", acceptEncoding: "identity", expectEncryptedContent: true });
  if (!compactRes3.messages || compactRes3.messages[0].encrypted_content !== "") {
    throw new Error(`expected encrypted_content to be populated in codex-everywhere compact response, got: ${JSON.stringify(compactRes3)}`);
  }

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
