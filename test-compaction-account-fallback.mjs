import assert from "node:assert/strict";
import { runLocalCompactionFallbackAcrossAccounts } from "./src/proxy-compaction.mjs";

// Deterministic test for the last-resort cross-account compaction fallback:
// 1. Active account fails every shape attempt -> second account succeeds.
// 2. Every account fails -> returns null (caller surfaces 502).
// 3. Pinned routes must NOT cross-account failover.
// 4. Exhausted accounts in the registry are skipped by the chain.
// 5. The active account key is never mutated by the fallback.

function compactInput() {
  return [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Hello there" }]
  }, {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Hi! How can I help today?" }]
  }];
}

function compactV2RequestBody() {
  return {
    model: "gpt-5.6-sol",
    input: compactInput(),
    client_metadata: { compacts_on_model_oag: true },
    compaction_trigger: "auto"
  };
}

function makeTarget(accountKey, upstreamBaseUrl) {
  return {
    account: { account_key: accountKey, alias: accountKey },
    apiKey: `${accountKey}-secret`,
    upstreamBaseUrl,
    url: `${upstreamBaseUrl.replace(/\/+$/, "")}/responses/compact`,
    chatgpt: false,
    apiTemplate: "openai"
  };
}

function makeCandidateList(accounts) {
  return (codexHome, options = {}) => {
    const exclude = new Set(options.excludeAccountKeys || []);
    return accounts
      .filter((entry) => !exclude.has(entry.key))
      .map((entry) => ({
        account: { account_key: entry.key, alias: entry.key },
        apiKey: `${entry.key}-secret`,
        upstreamBaseUrl: entry.upstreamBaseUrl,
        chatgpt: false,
        apiTemplate: "openai"
      }));
  };
}

function okResponsesBody(text) {
  return {
    id: "resp_test",
    object: "response",
    status: "completed",
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }]
    }]
  };
}

function installFetchByHost(handlers) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const targetUrl = new URL(String(url));
    const host = targetUrl.host;
    const pathname = targetUrl.pathname;
    calls.push({ url: String(url), host, pathname });
    const handler = handlers[host];
    if (!handler) {
      return new Response(JSON.stringify({ error: { message: "no handler for host" } }), {
        status: 500,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname.endsWith("/v1/responses")) return handler.responses();
    if (pathname.endsWith("/v1/chat/completions")) return handler.completions();
    return new Response(JSON.stringify({ error: { message: "unexpected path" } }), {
      status: 500,
      headers: { "content-type": "application/json" }
    });
  };
  return calls;
}

function okResponseJson(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function failingResponse(message) {
  return new Response(JSON.stringify({ error: { message } }), {
    status: 500,
    headers: { "content-type": "application/json" }
  });
}

async function run() {
  const originalFetch = globalThis.fetch;
  try {
    const body = JSON.stringify(compactV2RequestBody());
    const headers = { "content-type": "application/json" };
    const sanitize = () => ({});

    // Case 1: active account fails on both shapes; secondary succeeds on /responses.
    {
      const calls = installFetchByHost({
        "primary.test": {
          responses: () => failingResponse("primary down"),
          completions: () => failingResponse("primary down")
        },
        "secondary.test": {
          responses: () => okResponseJson(okResponsesBody("summary from secondary")),
          completions: () => failingResponse("secondary completions not reached")
        }
      });
      const accounts = [
        { key: "primary", upstreamBaseUrl: "http://primary.test/v1" },
        { key: "secondary", upstreamBaseUrl: "http://secondary.test/v1" }
      ];
      const activeTarget = makeTarget("primary", "http://primary.test/v1");
      const result = await runLocalCompactionFallbackAcrossAccounts(
        activeTarget,
        Buffer.from(body),
        headers,
        true,
        sanitize,
        {
          codexHome: "/fake/codex-home",
          listCompactionAccountCandidates: makeCandidateList(accounts),
          remoteCompactionV2: true,
          originalModel: "gpt-5.6-sol"
        }
      );
      assert.ok(result, "secondary account should produce a successful summary");
      const text = await result.text();
      assert.ok(text.includes("data:"), "v2 compaction response should be SSE");
      const primaryCalls = calls.filter((c) => c.host === "primary.test");
      const secondaryCalls = calls.filter((c) => c.host === "secondary.test");
      assert.ok(primaryCalls.length > 0, "primary account should be tried first");
      assert.ok(secondaryCalls.length > 0, "secondary account should be tried after primary fails");
      assert.ok(secondaryCalls.some((c) => c.pathname.endsWith("/v1/responses")), "secondary should be hit on /v1/responses");
      assert.ok(!secondaryCalls.some((c) => c.pathname.endsWith("/v1/chat/completions")), "secondary should succeed on first shape and never need /v1/chat/completions");
    }

    // Case 2: every account fails -> returns null.
    {
      installFetchByHost({
        "primary.test": {
          responses: () => failingResponse("primary down"),
          completions: () => failingResponse("primary down")
        },
        "secondary.test": {
          responses: () => failingResponse("secondary down"),
          completions: () => failingResponse("secondary down")
        }
      });
      const accounts = [
        { key: "primary", upstreamBaseUrl: "http://primary.test/v1" },
        { key: "secondary", upstreamBaseUrl: "http://secondary.test/v1" }
      ];
      const activeTarget = makeTarget("primary", "http://primary.test/v1");
      const result = await runLocalCompactionFallbackAcrossAccounts(
        activeTarget,
        Buffer.from(body),
        headers,
        true,
        sanitize,
        {
          codexHome: "/fake/codex-home",
          listCompactionAccountCandidates: makeCandidateList(accounts),
          remoteCompactionV2: true,
          originalModel: "gpt-5.6-sol"
        }
      );
      assert.equal(result, null, "fallback should return null when every account fails");
    }

    // Case 3: pinned routes must not cross-account failover.
    {
      const calls = installFetchByHost({
        "pinned.test": {
          responses: () => failingResponse("pinned down"),
          completions: () => failingResponse("pinned down")
        },
        "other.test": {
          responses: () => okResponseJson(okResponsesBody("should never reach other account")),
          completions: () => okResponseJson({ choices: [] })
        }
      });
      const pinnedTarget = makeTarget("pinned-acct", "http://pinned.test/v1");
      const result = await runLocalCompactionFallbackAcrossAccounts(
        pinnedTarget,
        Buffer.from(body),
        headers,
        true,
        sanitize,
        {
          codexHome: "/fake/codex-home",
          listCompactionAccountCandidates: makeCandidateList([
            { key: "pinned-acct", upstreamBaseUrl: "http://pinned.test/v1" },
            { key: "other", upstreamBaseUrl: "http://other.test/v1" }
          ]),
          pinnedOnly: true,
          remoteCompactionV2: true,
          originalModel: "gpt-5.6-sol"
        }
      );
      assert.equal(result, null, "pinned route should not find a fallback account");
      assert.ok(calls.every((c) => c.host === "pinned.test"), "pinned route should only hit the pinned account");
      assert.ok(!calls.some((c) => c.host === "other.test"), "pinned route should never hit other accounts");
    }

    // Case 4: exhausted accounts must be skipped by the candidate list.
    {
      const calls = installFetchByHost({
        "primary.test": {
          responses: () => failingResponse("primary down"),
          completions: () => failingResponse("primary down")
        },
        "secondary.test": {
          responses: () => okResponseJson(okResponsesBody("secondary ok")),
          completions: () => okResponseJson({ choices: [] })
        }
      });
      const accounts = [
        { key: "primary", upstreamBaseUrl: "http://primary.test/v1" },
        { key: "secondary", upstreamBaseUrl: "http://secondary.test/v1" }
      ];
      const activeTarget = makeTarget("primary", "http://primary.test/v1");
      const result = await runLocalCompactionFallbackAcrossAccounts(
        activeTarget,
        Buffer.from(body),
        headers,
        true,
        sanitize,
        {
          codexHome: "/fake/codex-home",
          listCompactionAccountCandidates: makeCandidateList(accounts),
          excludeAccountKeys: ["secondary"],
          remoteCompactionV2: true,
          originalModel: "gpt-5.6-sol"
        }
      );
      assert.equal(result, null, "excluding the only fallback candidate should make the chain return null");
      assert.ok(!calls.some((c) => c.host === "secondary.test"), "exhausted/excluded secondary should not be called");
    }

    // Case 5: registry active account must NOT be mutated by the fallback chain.
    {
      const registry = { active_account_key: "primary", accounts: [
        { account_key: "primary", auth_mode: "apikey" },
        { account_key: "secondary", auth_mode: "apikey" }
      ] };
      installFetchByHost({
        "primary.test": {
          responses: () => failingResponse("primary down"),
          completions: () => failingResponse("primary down")
        },
        "secondary.test": {
          responses: () => okResponseJson(okResponsesBody("secondary ok")),
          completions: () => okResponseJson({ choices: [] })
        }
      });
      const accounts = [
        { key: "primary", upstreamBaseUrl: "http://primary.test/v1" },
        { key: "secondary", upstreamBaseUrl: "http://secondary.test/v1" }
      ];
      const activeTarget = makeTarget("primary", "http://primary.test/v1");
      await runLocalCompactionFallbackAcrossAccounts(
        activeTarget,
        Buffer.from(body),
        headers,
        true,
        sanitize,
        {
          codexHome: "/fake/codex-home",
          listCompactionAccountCandidates: makeCandidateList(accounts),
          remoteCompactionV2: true,
          originalModel: "gpt-5.6-sol"
        }
      );
      assert.equal(registry.active_account_key, "primary", "fallback chain must not mutate the active account");
    }

    console.log("test-compaction-account-fallback: all assertions passed");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

run().catch((err) => {
  console.error("test-compaction-account-fallback failed:", err);
  process.exit(1);
});
