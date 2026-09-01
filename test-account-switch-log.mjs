// Unit tests for the [Account Switch] structured log line emitted by
// switchToStoredAccount (src/account-service.mjs). The log line is the
// operator's only way to tell a manual `codex-auth-advanced switch …`
// command from an auto-exhausted flip triggered by the daemon or by the
// proxy's recovery path. A regression here would silently mask operator
// intent in the proxy log.
//
// We capture process.stdout.write, call switchToStoredAccount directly
// against an in-memory registry, and assert the captured lines carry the
// expected origin / from / to fields. No network, no real proxy — this
// stays a pure unit test of the log contract.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureDir, writeJsonFile, writeTextFilePrivate, readJsonFile } from "./src/storage.mjs";
import { createProviderProxy, requestIdLogFragment } from "./src/provider-proxy.mjs";
import { createAccountService } from "./src/account-service.mjs";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switch-log-"));
try {
  const serviceHome = path.join(tempRoot, "codex");
  const serviceAccountsDir = path.join(serviceHome, "accounts");
  ensureDir(serviceAccountsDir);

  const activeAccount = {
    account_key: "apikey-active",
    alias: "vsllm-active",
    auth_mode: "apikey",
    created_at: 10
  };
  const fallbackAccount = {
    account_key: "apikey-fallback",
    alias: "llmapi-fallback",
    auth_mode: "apikey",
    created_at: 20
  };

  writeJsonFile(path.join(serviceAccountsDir, "registry.json"), {
    active_account_key: activeAccount.account_key,
    auto_switch: { enabled: true },
    accounts: [activeAccount, fallbackAccount]
  });
  writeJsonFile(
    path.join(serviceAccountsDir, `${activeAccount.account_key}.auth.json`),
    {
      auth_mode: "apikey",
      OPENAI_API_KEY: "primary-secret",
      account_key: activeAccount.account_key
    }
  );
  writeTextFilePrivate(
    path.join(serviceAccountsDir, `${activeAccount.account_key}.config.toml`),
    [
      'model_provider = "OpenAI"',
      "",
      "[model_providers.OpenAI]",
      'base_url = "https://vsllm.com/v1"',
      'wire_api = "responses"',
      ""
    ].join("\n")
  );
  writeJsonFile(
    path.join(serviceAccountsDir, `${fallbackAccount.account_key}.auth.json`),
    {
      auth_mode: "apikey",
      OPENAI_API_KEY: "fallback-secret",
      account_key: fallbackAccount.account_key
    }
  );
  writeTextFilePrivate(
    path.join(serviceAccountsDir, `${fallbackAccount.account_key}.config.toml`),
    [
      'model_provider = "OpenAI"',
      "",
      "[model_providers.OpenAI]",
      'base_url = "https://llmapi.pro/v1"',
      'wire_api = "responses"',
      ""
    ].join("\n")
  );
  writeTextFilePrivate(path.join(serviceHome, "config.toml"), [
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "max"',
    ""
  ].join("\n"));

  const proxy = createProviderProxy({ ensureRunning: async () => true });
  const accountService = createAccountService({
    providerProxy: proxy,
    chatgptCodexBaseUrl: "https://chatgpt.com/backend-api/codex"
  });

  function captureStdout() {
    const captured = [];
    const original = process.stdout.write.bind(process.stdout);
    // process.stdout.write has multiple overloads; only intercept string
    // chunks so util.format-style args keep working.
    process.stdout.write = (chunk, ...rest) => {
      if (typeof chunk === "string") captured.push(chunk);
      return original(chunk, ...rest);
    };
    return {
      captured,
      restore() {
        process.stdout.write = original;
      }
    };
  }

  // 1) Default reason is `manual` — covers direct `switch <query>`,
  // interactive picker, and `handleLiveStoredSwitch --auto`.
  {
    const tap = captureStdout();
    try {
      await accountService.switchToStoredAccount(serviceHome, fallbackAccount);
    } finally {
      tap.restore();
    }
    const out = tap.captured.join("");
    assert.ok(
      out.includes("[Account Switch]"),
      `expected [Account Switch] line, got: ${out}`
    );
    assert.ok(
      /\[Account Switch\] origin=manual from=vsllm-active to=llmapi-fallback at_ms=\d+/.test(out),
      `expected origin=manual from=vsllm-active to=llmapi-fallback, got: ${out}`
    );
    // Legacy line preserved for backwards compatibility with anything that
    // greps for `Switched to <alias>.`
    assert.ok(out.includes("Switched to llmapi-fallback."), out);
  }

  // 2) `auto-exhausted` reason from the proxy recovery / daemon paths.
  // After test 1 the active account is now the fallback, so flip back to
  // the active one with the auto-exhausted origin to assert the origin
  // tagging path.
  {
    const tap = captureStdout();
    try {
      await accountService.switchToStoredAccount(serviceHome, activeAccount, {
        reason: "auto-exhausted",
        status: 429,
        classify: "quota_exhausted"
      });
    } finally {
      tap.restore();
    }
    const out = tap.captured.join("");
    assert.ok(
      /\[Account Switch\] origin=auto-exhausted from=llmapi-fallback to=vsllm-active at_ms=\d+ status=429 classify=quota_exhausted/.test(
        out
      ),
      `expected origin=auto-exhausted with status/classify, got: ${out}`
    );
  }

  // 3) Defensive: an unrecognized reason downgrades to `manual` so we
  // never silently relabel a real event. The registry swap still happens.
  {
    const tap = captureStdout();
    try {
      await accountService.switchToStoredAccount(serviceHome, fallbackAccount, {
        reason: "garbage-value"
      });
    } finally {
      tap.restore();
    }
    const out = tap.captured.join("");
    assert.ok(
      /\[Account Switch\] origin=manual from=vsllm-active to=llmapi-fallback/.test(out),
      `expected unknown reason to fall back to manual, got: ${out}`
    );
  }

  // 4) After all three flips the registry points back at the fallback
  // account from test 3, confirming switchToStoredAccount kept its
  // existing mutation contract intact while adding the log line.
  {
    const registry = readJsonFile(path.join(serviceAccountsDir, "registry.json"));
    assert.equal(registry.active_account_key, fallbackAccount.account_key);
  }

  // 5) requestIdLogFragment: a non-empty string returns the formatted
  // fragment; an empty / missing / non-string request id returns an empty
  // string so log lines stay well-formed when the helper is bypassed.
  assert.equal(
    requestIdLogFragment("11111111-2222-3333-4444-555555555555"),
    " req_id=11111111-2222-3333-4444-555555555555"
  );
  assert.equal(requestIdLogFragment(""), "");
  assert.equal(requestIdLogFragment(null), "");
  assert.equal(requestIdLogFragment(undefined), "");
  assert.equal(requestIdLogFragment(123), "");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

process.stdout.write("account switch log origin tagging ok\n");
