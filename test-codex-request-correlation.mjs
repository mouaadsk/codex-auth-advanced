// Unit tests for the Codex request correlation helpers added to
// src/provider-proxy.mjs. These helpers enrich proxy log lines so operators
// can grep a single [Proxy Request] entry and jump straight to the matching
// ~/.codex/sessions/.../rollout-<id>.jsonl file.
//
// Codex CLI does NOT transmit a session id over the wire (it is only in the
// local JSONL filename), so the helpers surface: codex_home (already known
// from the URL path) and turn id (parsed from
// input[*].internal_chat_message_metadata_passthrough.turn_id).

import assert from "node:assert/strict";
import {
  extractCodexRequestCorrelation,
  codexCorrelationLogSuffix
} from "./src/provider-proxy.mjs";

const route = { codexHome: "/Users/mouaad-mac/.codex" };

// 1) Empty / null body should not throw and should yield nulls.
{
  const out = extractCodexRequestCorrelation(null, route);
  assert.equal(out.codexHome, "/Users/mouaad-mac/.codex");
  assert.equal(out.sessionId, null);
  assert.equal(out.turnId, null);
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
    turnId: "01a058ab-f89a-7ac1-a403-60f54be0ed1a"
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
    turnId: null
  });
  assert.equal(suffix, " | codex_home=/Users/mouaad-mac/.codex");
}

// 9) Suffix formatting: empty correlation yields empty string.
{
  assert.equal(codexCorrelationLogSuffix(null), "");
  assert.equal(codexCorrelationLogSuffix({}), "");
}

process.stdout.write("codex request correlation helpers ok\n");
