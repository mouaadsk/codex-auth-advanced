import assert from "node:assert/strict";
import { fork } from "node:child_process";
import net from "node:net";
import { once } from "node:events";
import { createProviderProxy } from "./src/provider-proxy.mjs";

if (process.env.PROXY_REGRESSION_CHILD === "1") {
  process.env.CODEX_AUTH_ADVANCED_DISABLE_SHAPE_PROBE = "1";
  const port = Number(process.env.PROXY_REGRESSION_PORT);
  const primary = {
    account: { account_key: "primary", alias: "vsllm-primary" },
    apiTemplate: "vsllm",
    upstreamBaseUrl: "https://primary.test/v1",
    apiKey: "fixture-primary"
  };
  const secondary = {
    account: { account_key: "secondary", alias: "secondary" },
    apiTemplate: "openai",
    upstreamBaseUrl: "https://secondary.test/v1",
    apiKey: "fixture-secondary",
    url: "https://secondary.test/v1/responses"
  };
  globalThis.fetch = async (url, init = {}) => {
    const raw = String(init.body || "");
    let payload;
    try { payload = JSON.parse(raw); } catch {}
    process.send?.({ type: "upstream", url: String(url), payload, raw });
    if (payload?.model === "bodyless") return new Response(null, { status: 204 });
    if (!payload) return new Response("unsupported", { status: 404 });
    if (payload.model === "account-reset" && String(url).includes("primary.test")) {
      return Response.json({ error: { message: "Selected model is at capacity. Please try a different model.", code: "server_overloaded" } }, { status: 503 });
    }
    if (String(url).includes("/chat/completions")) {
      return Response.json({
        id: "chat_fixture", object: "chat.completion", model: payload.model,
        choices: [{ index: 0, message: { role: "assistant", content: "fixture answer" }, finish_reason: "stop" }]
      });
    }
    return Response.json({
      id: "resp_fixture", object: "response", status: "completed",
      model: payload.model,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "fixture answer" }] }]
    });
  };
  const proxy = createProviderProxy({
    host: "127.0.0.1", port, prefix: "/_codex-auth-advanced",
    activeApiProxyTarget: () => ({ ...primary }),
    pinnedApiProxyTarget: () => ({ ...primary }),
    markApiAccountExhaustedFromProxy: () => {},
    switchFromExhaustedApiAccount: async () => false,
    targetFromTransientApiFailure: async (_home, _req, options) =>
      options.excludeAccountKeys.has("secondary") ? null : { ...secondary },
    listCompactionAccountCandidates: () => [],
    modelCapacityMaxRetries: 0,
    modelCapacityRetryBaseDelayMs: 0,
    vsllmTransientUsageLimitMaxRetries: 0,
    vsllmTransientUsageLimitRetryDelayMs: 0,
    streamStallWatchdogMs: 2000
  });
  proxy.startServer();
  process.on("message", (message) => {
    if (message === "finish-fixture") process.exit(0);
  });
} else {
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = fork(new URL(import.meta.url), [], {
    env: { ...process.env, PROXY_REGRESSION_CHILD: "1", PROXY_REGRESSION_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  const calls = [];
  let diagnostics = "";
  child.on("message", (message) => {
    if (message.type === "upstream") calls.push(message);
  });
  child.stdout.on("data", (chunk) => { diagnostics += chunk; });
  child.stderr.on("data", (chunk) => { diagnostics += chunk; });
  const origin = `http://127.0.0.1:${port}`;
  const group = Buffer.from("/tmp/proxy-regression-no-credentials").toString("base64url");
  const base = `${origin}/_codex-auth-advanced/${group}`;
  async function request(body, suffix = "/responses") {
    return fetch(`${base}${suffix}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(5000)
    });
  }
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode != null) throw new Error(diagnostics);
      try {
        const health = await fetch(`${origin}/_codex-auth-advanced/health`);
        if (health.ok) { ready = true; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.ok(ready, diagnostics);

    const pinnedStart = calls.length;
    const pinned = await request({ model: "pinned-model", input: "hello" }, "/accounts/primary/v1/responses");
    assert.equal(pinned.status, 200);
    await pinned.text();
    assert.ok(calls[pinnedStart].url.endsWith("/v1/responses"), "pinned route must retain caller protocol");

    const bodyless = await request({ model: "bodyless", input: "hello" });
    assert.equal(bodyless.status, 204);
    assert.equal(await bodyless.text(), "");

    const malformedStart = calls.length;
    const malformed = await request("{");
    assert.equal(malformed.status, 404, "unavailable bridges must terminate without replaying upstream");
    await malformed.text();
    assert.equal(calls.length - malformedStart, 1);

    const resetStart = calls.length;
    const reset = await request({
      model: "account-reset", input: [{ role: "user", content: "hello" }],
      reasoning: { effort: "high" }
    });
    assert.equal(reset.status, 200, diagnostics);
    const result = await reset.json();
    assert.equal(result.object, "response");
    const secondAccount = calls.slice(resetStart).find((call) => call.url.includes("secondary.test"));
    assert.ok(secondAccount, "capacity failover must reach the second account");
    assert.ok(secondAccount.url.endsWith("/v1/responses"));
    assert.ok(Array.isArray(secondAccount.payload.input), "rebuild original Responses payload");
    assert.equal(secondAccount.payload.messages, undefined, "discard previous account's Chat payload");
    assert.equal(secondAccount.payload.reasoning.effort, "high");
    assert.equal(secondAccount.payload.model, "account-reset");
    assert.ok(!diagnostics.includes("ReferenceError"), diagnostics);
    console.log("provider proxy routing regressions ok");
  } finally {
    const exited = once(child, "exit");
    if (child.connected) child.send("finish-fixture");
    if (child.exitCode == null) await exited;
  }
}
