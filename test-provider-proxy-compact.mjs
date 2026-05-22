import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = new URL(".", import.meta.url).pathname;
const wrapper = path.join(repoRoot, "bin", "codex-auth-advanced.js");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-advanced-compact-"));
const codexHome = path.join(tempRoot, "codex-home");
const accountsDir = path.join(codexHome, "accounts");
fs.mkdirSync(accountsDir, { recursive: true, mode: 0o700 });

const upstreamRequests = [];
const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const bodyText = Buffer.concat(chunks).toString("utf8");
  upstreamRequests.push({
    method: req.method,
    url: req.url,
    authorization: req.headers.authorization,
    acceptEncoding: req.headers["accept-encoding"],
    bodyText
  });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: req.url.endsWith("/compact") ? "response.compaction" : "response.completed" }));
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

function assertLatestRequest(expected) {
  const latest = upstreamRequests.at(-1);
  const parsed = JSON.parse(latest.bodyText);
  if (latest.authorization !== `Bearer ${expected.bearer}`) {
    throw new Error(`unexpected authorization header: ${latest.authorization}`);
  }
  if (expected.acceptEncoding != null && latest.acceptEncoding !== expected.acceptEncoding) {
    throw new Error(`unexpected accept-encoding for ${expected.label}: ${latest.acceptEncoding}`);
  }
  const serialized = JSON.stringify(parsed);
  if (expected.expectEncryptedContent && !serialized.includes("encrypted")) {
    throw new Error(`${expected.label} should have preserved encrypted content`);
  }
  if (!expected.expectEncryptedContent && serialized.includes("encrypted")) {
    throw new Error(`${expected.label} should have removed encrypted content`);
  }
  if (expected.expectReasoning === false && serialized.includes('"type":"reasoning"')) {
    throw new Error(`${expected.label} should have removed encrypted reasoning items`);
  }
  if (!expected.expectEncryptedContent) {
    const assistantMsg = parsed.input.find(x => x.type === "message" && x.role === "assistant");
    if (assistantMsg && assistantMsg.content !== undefined) {
      throw new Error(`expected assistant message to have no content property, got ${JSON.stringify(assistantMsg.content)}`);
    }
  }
}

const upstreamPort = await listen(upstream);
const upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}`;
const accounts = [
  writeAccount({ key: "apikey-codex-everywhere", alias: "codex-everywhere", template: "codex-everywhere", baseUrl: upstreamBaseUrl }),
  writeAccount({ key: "apikey-tcdmx", alias: "tcdmx", template: "tcdmx", baseUrl: upstreamBaseUrl }),
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
        encrypted_content: "encrypted-assistant-message"
      }
    ]
  };

  setActive("apikey-tcdmx");
  await proxyRequest(proxyPort, "/responses/compact", body);
  assertLatestRequest({ label: "tcdmx compact", bearer: "tcdmx-secret", acceptEncoding: "identity", expectEncryptedContent: false, expectReasoning: false });

  await proxyRequest(proxyPort, "/responses", body);
  assertLatestRequest({ label: "tcdmx responses", bearer: "tcdmx-secret", acceptEncoding: "identity", expectEncryptedContent: true });

  setActive("apikey-codex-everywhere");
  await proxyRequest(proxyPort, "/responses/compact", body);
  assertLatestRequest({ label: "codex-everywhere compact", bearer: "codex-everywhere-secret", acceptEncoding: "identity", expectEncryptedContent: false, expectReasoning: false });

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
