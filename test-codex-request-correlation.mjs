// Unit tests for the Codex request correlation helpers added to
// src/provider-proxy.mjs. These helpers enrich proxy log lines so operators
// can grep a single [Proxy Request] entry and jump straight to the matching
// ~/.codex/sessions/.../rollout-<id>.jsonl file.
//
// Codex CLI does NOT transmit a session id over the wire (it is only in the
// local JSONL filename), so the helpers surface: codex_home (already known
// from the URL path) and turn id (parsed from
// input[*].internal_chat_message_metadata_passthrough.turn_id). When the
// caller supplies a turn_id -> sessionId index (built by scanning the
// local session files), the helper also surfaces session id and the
// human-readable thread name so log lines carry the full breadcrumb.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractCodexRequestCorrelation,
  codexCorrelationLogSuffix,
  createCodexSessionIndex,
  loadCodexThreadNames
} from "./src/provider-proxy.mjs";

const route = { codexHome: "/Users/mouaad-mac/.codex" };

// 1) Empty / null body should not throw and should yield nulls.
{
  const out = extractCodexRequestCorrelation(null, route);
  assert.equal(out.codexHome, "/Users/mouaad-mac/.codex");
  assert.equal(out.sessionId, null);
  assert.equal(out.turnId, null);
  assert.equal(out.threadName, null);
}

// 2) Empty Buffer body should also yield nulls safely.
{
  const out = extractCodexRequestCorrelation(Buffer.alloc(0), route);
  assert.equal(out.codexHome, "/Users/mouaad-mac/.codex");
  assert.equal(out.turnId, null);
}

// 3) Body with input[] carrying the turn id — last occurrence wins.
{
  const body = JSON.stringify({
    model: "gpt-5.6-sol",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "earlier turn" }] },
      { type: "function_call", call_id: "x", name: "exec", arguments: "{}" },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "you have access" }],
        internal_chat_message_metadata_passthrough: {
          turn_id: "01a058ab-f89a-7ac1-a403-60f54be0ed1a",
          create_time: 1788194060,
          content_item_kinds: ["user.text"]
        }
      }
    ]
  });
  const out = extractCodexRequestCorrelation(Buffer.from(body, "utf8"), route);
  assert.equal(out.codexHome, "/Users/mouaad-mac/.codex");
  assert.equal(out.turnId, "01a058ab-f89a-7ac1-a403-60f54be0ed1a");
  assert.equal(out.sessionId, null);
}

// 4) Body without input[] (e.g. compact) → turnId is null.
{
  const body = JSON.stringify({ model: "gpt-5.6-sol", input: [] });
  const out = extractCodexRequestCorrelation(Buffer.from(body, "utf8"), route);
  assert.equal(out.turnId, null);
}

// 5) Non-JSON Buffer body → no throw, turnId null.
{
  const out = extractCodexRequestCorrelation(Buffer.from("not json"), route);
  assert.equal(out.turnId, null);
}

// 6) Missing route → codexHome is null but no throw.
{
  const out = extractCodexRequestCorrelation(Buffer.from("{}"), null);
  assert.equal(out.codexHome, null);
  assert.equal(out.turnId, null);
}

// 7) Suffix formatting: with turn id, output contains both fields.
{
  const suffix = codexCorrelationLogSuffix({
    codexHome: "/Users/mouaad-mac/.codex",
    sessionId: null,
    turnId: "01a058ab-f89a-7ac1-a403-60f54be0ed1a",
    threadName: null
  });
  assert.equal(
    suffix,
    " | codex_home=/Users/mouaad-mac/.codex turn=01a058ab-f89a-7ac1-a403-60f54be0ed1a"
  );
}

// 8) Suffix formatting: without turn id, output contains only codex_home.
{
  const suffix = codexCorrelationLogSuffix({
    codexHome: "/Users/mouaad-mac/.codex",
    sessionId: null,
    turnId: null,
    threadName: null
  });
  assert.equal(suffix, " | codex_home=/Users/mouaad-mac/.codex");
}

// 9) Suffix formatting: empty correlation yields empty string.
{
  assert.equal(codexCorrelationLogSuffix(null), "");
  assert.equal(codexCorrelationLogSuffix({}), "");
}

// 10) Body with turn id + supplied index → sessionId/threadName surface.
{
  const body = JSON.stringify({
    model: "gpt-5.6-sol",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn-abc" }
    }]
  });
  const index = new Map([
    ["turn-abc", {
      sessionId: "sess-xyz",
      sessionFile: "/tmp/rollout-sess-xyz.jsonl",
      threadName: "Fix the proxy"
    }]
  ]);
  const out = extractCodexRequestCorrelation(Buffer.from(body, "utf8"), route, index);
  assert.equal(out.turnId, "turn-abc");
  assert.equal(out.sessionId, "sess-xyz");
  assert.equal(out.threadName, "Fix the proxy");
}

// 11) Body with turn id but no index hit → sessionId/threadName stay null.
{
  const body = JSON.stringify({
    model: "gpt-5.6-sol",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn-unknown" }
    }]
  });
  const out = extractCodexRequestCorrelation(Buffer.from(body, "utf8"), route, new Map());
  assert.equal(out.turnId, "turn-unknown");
  assert.equal(out.sessionId, null);
  assert.equal(out.threadName, null);
}

// 12) Suffix formatting: full breadcrumb (home + turn + session + thread).
{
  const suffix = codexCorrelationLogSuffix({
    codexHome: "/Users/mouaad-mac/.codex",
    sessionId: "sess-xyz",
    turnId: "turn-abc",
    threadName: "Fix the proxy"
  });
  assert.equal(
    suffix,
    ' | codex_home=/Users/mouaad-mac/.codex turn=turn-abc session=sess-xyz thread="Fix the proxy"'
  );
}

// 13) Suffix formatting: thread name with embedded quotes is escaped.
{
  const suffix = codexCorrelationLogSuffix({
    codexHome: "/Users/mouaad-mac/.codex",
    sessionId: "sess-xyz",
    turnId: "turn-abc",
    threadName: 'He said "go"'
  });
  assert.equal(
    suffix,
    ' | codex_home=/Users/mouaad-mac/.codex turn=turn-abc session=sess-xyz thread="He said \\"go\\""'
  );
}

// 14) loadCodexThreadNames: empty/missing index returns empty map.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-corr-"));
  try {
    const map = loadCodexThreadNames(tmp);
    assert.equal(map.size, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 15) loadCodexThreadNames: parses session_index.jsonl.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-corr-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "session_index.jsonl"),
      [
        JSON.stringify({ id: "sess-a", thread_name: "Investigate 429", updated_at: "2026-08-31T00:00:00Z" }),
        JSON.stringify({ id: "sess-b", thread_name: "Add session-id logs", updated_at: "2026-08-31T00:01:00Z" })
      ].join("\n") + "\n"
    );
    const map = loadCodexThreadNames(tmp);
    assert.equal(map.size, 2);
    assert.equal(map.get("sess-a"), "Investigate 429");
    assert.equal(map.get("sess-b"), "Add session-id logs");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 16) createCodexSessionIndex: builds turn_id -> sessionId map from a
// fake codex_home with a single rollout file. cacheTtlMs=0 forces a fresh
// scan each call so the test is deterministic.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-corr-"));
  try {
    const dayDir = path.join(tmp, "sessions", "2026", "08", "31");
    fs.mkdirSync(dayDir, { recursive: true });
    const sessionId = "01a05989-66fa-7821-90ec-83d2473b2c27";
    const sessionFile = path.join(dayDir, `rollout-2026-08-31T21-36-12-${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({
        timestamp: "2026-08-31T20:36:12.265Z",
        ordinal: 309,
        type: "session_meta",
        payload: { session_id: sessionId, cwd: "/Users/mouaad-mac/AI/Trading Research Framework" }
      }),
      JSON.stringify({
        timestamp: "2026-08-31T20:36:19.985Z",
        ordinal: 312,
        type: "event_msg",
        payload: { type: "task_started", turn_id: "01a05989-8588-7e02-a406-20118fee5553" }
      }),
      JSON.stringify({
        timestamp: "2026-08-31T20:36:25.000Z",
        ordinal: 313,
        type: "event_msg",
        payload: { type: "user_message", turn_id: "01a05989-8588-7e02-a406-20118fee5553" }
      })
    ];
    fs.writeFileSync(sessionFile, lines.join("\n") + "\n");

    // Add a session_index.jsonl with the thread name.
    fs.writeFileSync(
      path.join(tmp, "session_index.jsonl"),
      JSON.stringify({ id: sessionId, thread_name: "Proxy hardening", updated_at: "2026-08-31T20:36:13Z" }) + "\n"
    );

    const index = createCodexSessionIndex({ cacheTtlMs: 0, maxFiles: 50 });
    const map = await index.get(tmp);
    assert.equal(map.size, 2, "expected 2 entries (1 turn id + 1 session key)");
    const turnHit = map.get("01a05989-8588-7e02-a406-20118fee5553");
    assert.ok(turnHit, "turn id should be present");
    assert.equal(turnHit.sessionId, sessionId);
    assert.equal(turnHit.threadName, "Proxy hardening");
    assert.equal(turnHit.sessionFile, sessionFile);
    const sessionHit = map.get(`session:${sessionId}`);
    assert.ok(sessionHit, "session key should be present");
    assert.equal(sessionHit.sessionId, sessionId);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 17) createCodexSessionIndex: missing sessions dir returns empty map.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-corr-"));
  try {
    const index = createCodexSessionIndex({ cacheTtlMs: 0, maxFiles: 50 });
    const map = await index.get(tmp);
    assert.equal(map.size, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 18) createCodexSessionIndex: TTL cache prevents re-scan on second call.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-corr-"));
  try {
    const dayDir = path.join(tmp, "sessions", "2026", "08", "31");
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(
      path.join(dayDir, "rollout-x.jsonl"),
      JSON.stringify({ type: "session_meta", payload: { session_id: "sess-x" } }) + "\n" +
      JSON.stringify({ payload: { turn_id: "turn-x" } }) + "\n"
    );
    const index = createCodexSessionIndex({ cacheTtlMs: 60_000, maxFiles: 50 });
    const a = await index.get(tmp);
    assert.equal(a.size, 2);
    // Delete the file — second call should still return cached map (size
    // unchanged) because TTL has not expired.
    fs.rmSync(dayDir, { recursive: true, force: true });
    const b = await index.get(tmp);
    assert.equal(b.size, a.size);
    index.invalidate(tmp);
    // After invalidate the next call rebuilds and finds nothing.
    const c = await index.get(tmp);
    assert.equal(c.size, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

process.stdout.write("codex request correlation helpers ok\n");
