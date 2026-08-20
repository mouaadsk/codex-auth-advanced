import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  estimateClaudeInputTokens,
  prepareClaudeResponsesBridge,
  retargetClaudeResponsesBridge,
  translateClaudeMessagesRequestToResponses
} from "./src/claude-responses-core.mjs";
import { translateResponsesResponseToClaude } from "./src/claude-responses-responses.mjs";
import { createClaudeResponsesSseTransformStream } from "./src/claude-responses-sse.mjs";

const longToolName = `mcp__filesystem__${"inspect_repository_tree_".repeat(4)}`;
const longToolId = `toolu_${"1234567890".repeat(8)}`;
const claudeRequest = {
  model: "grok-4.5",
  max_tokens: 4096,
  stream: true,
  system: [{ type: "text", text: "Work carefully." }],
  thinking: { type: "enabled", budget_tokens: 16000 },
  tool_choice: { type: "tool", name: longToolName, disable_parallel_tool_use: true },
  tools: [{
    name: longToolName,
    description: "Inspect a path.",
    input_schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    }
  }],
  messages: [
    { role: "user", content: [{ type: "text", text: "Inspect /tmp." }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Need the tool.", signature: "encrypted-state" },
        { type: "tool_use", id: longToolId, name: longToolName, input: { path: "/tmp" } }
      ]
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: longToolId, content: [{ type: "text", text: "done" }] }]
    }
  ]
};

const translated = translateClaudeMessagesRequestToResponses(claudeRequest);
assert.equal(translated.model, "grok-4.5");
assert.equal(translated.stream, true);
assert.equal(translated.store, false);
assert.equal(translated.parallel_tool_calls, false);
assert.equal(translated.reasoning.effort, "high");
assert.equal(translated.reasoning.summary, "auto");
assert.equal(translated.tools.length, 1);
assert.ok(translated.tools[0].name.length <= 64);
assert.equal(translated.tools[0].parameters.$schema, undefined);
assert.equal(translated.tool_choice.name, translated.tools[0].name);
assert.equal(translated.input[0].role, "developer");
assert.equal(translated.input[0].content[0].text, "Work carefully.");
assert.ok(translated.input.some((item) => item.type === "reasoning" && item.encrypted_content === "encrypted-state"));
const translatedCall = translated.input.find((item) => item.type === "function_call");
const translatedResult = translated.input.find((item) => item.type === "function_call_output");
assert.ok(translatedCall.call_id.length <= 64);
assert.equal(translatedCall.call_id, translatedResult.call_id);
assert.equal(translatedCall.name, translated.tools[0].name);
assert.deepEqual(JSON.parse(translatedCall.arguments), { path: "/tmp" });

assert.ok(estimateClaudeInputTokens(claudeRequest) > 100);
assert.ok(estimateClaudeInputTokens({
  model: "grok-4.5",
  messages: [{
    role: "user",
    content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "a".repeat(5000) } }]
  }]
}) < 5000);

const bridgeTarget = {
  url: "https://vsllm.com/v1/messages?beta=true",
  upstreamBaseUrl: "https://vsllm.com",
  account: { alias: "vsllm", email: "vsllm@example.com" }
};
const prepared = prepareClaudeResponsesBridge(bridgeTarget, Buffer.from(JSON.stringify(claudeRequest)));
assert.equal(prepared.kind, "responses");
assert.equal(new URL(prepared.target.url).pathname, "/v1/responses");
assert.equal(new URL(prepared.target.url).search, "");
assert.equal(JSON.parse(prepared.body).model, "grok-4.5");
const retriedTarget = retargetClaudeResponsesBridge({
  ...bridgeTarget,
  url: "https://backup.vsllm.com/v1/messages?beta=true",
  account: { alias: "vsllm-2", email: "vsllm-2@example.com" }
}, prepared);
assert.equal(retriedTarget.account.alias, "vsllm-2");
assert.equal(retriedTarget.url, "https://backup.vsllm.com/v1/responses");
assert.equal(retriedTarget.claudeResponsesBridge, true);

const countPrepared = prepareClaudeResponsesBridge(
  { ...bridgeTarget, url: "https://vsllm.com/v1/messages/count_tokens?beta=true" },
  Buffer.from(JSON.stringify(claudeRequest))
);
assert.equal(countPrepared.kind, "count_tokens");
assert.ok(countPrepared.inputTokens > 100);

const nativePrepared = prepareClaudeResponsesBridge(
  bridgeTarget,
  Buffer.from(JSON.stringify({ ...claudeRequest, model: "kimi-k3" }))
);
assert.equal(nativePrepared, null);

const response = {
  id: "resp_nonstream",
  object: "response",
  model: "grok-4.5",
  output: [
    { type: "reasoning", summary: [{ type: "summary_text", text: "Use the tool." }], encrypted_content: "sig" },
    { type: "function_call", call_id: "call_1", name: translated.tools[0].name, arguments: "{\"path\":\"/tmp\"}" }
  ],
  usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 20 }, output_tokens: 15 }
};
const claudeNonStream = translateResponsesResponseToClaude(response, claudeRequest);
assert.equal(claudeNonStream.stop_reason, "tool_use");
assert.deepEqual(claudeNonStream.usage, { input_tokens: 100, output_tokens: 15, cache_read_input_tokens: 20 });
assert.equal(claudeNonStream.content[0].type, "thinking");
assert.equal(claudeNonStream.content[1].name, longToolName);
assert.deepEqual(claudeNonStream.content[1].input, { path: "/tmp" });

function upstreamEvent(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

const upstreamSse = [
  upstreamEvent("response.created", { response: { id: "resp_stream", model: "grok-4.5" } }),
  upstreamEvent("response.output_item.added", {
    output_index: 0,
    item: { id: "reasoning_1", type: "reasoning", encrypted_content: "" }
  }),
  upstreamEvent("response.reasoning_summary_part.added", { output_index: 0, part: { type: "summary_text", text: "" } }),
  upstreamEvent("response.reasoning_summary_text.delta", { output_index: 0, delta: "Call the tool." }),
  upstreamEvent("response.reasoning_summary_part.done", { output_index: 0 }),
  upstreamEvent("response.output_item.done", {
    output_index: 0,
    item: { id: "reasoning_1", type: "reasoning", summary: [{ type: "summary_text", text: "Call the tool." }], encrypted_content: "" }
  }),
  upstreamEvent("response.output_item.added", {
    output_index: 1,
    item: { id: "function_1", type: "function_call", call_id: "call_1", name: translated.tools[0].name, arguments: "" }
  }),
  upstreamEvent("response.function_call_arguments.delta", {
    output_index: 1,
    item_id: "function_1",
    delta: "{\"path\":\"/tmp\"}"
  }),
  upstreamEvent("response.function_call_arguments.done", {
    output_index: 1,
    item_id: "function_1",
    arguments: "{\"path\":\"/tmp\"}"
  }),
  upstreamEvent("response.output_item.done", {
    output_index: 1,
    item: { id: "function_1", type: "function_call", call_id: "call_1", name: translated.tools[0].name, arguments: "{\"path\":\"/tmp\"}" }
  }),
  upstreamEvent("response.completed", { response })
].join("");

async function transformedText(chunks, request = claudeRequest) {
  const stream = Readable.from(chunks).pipe(createClaudeResponsesSseTransformStream(request));
  let output = "";
  for await (const chunk of stream) output += chunk.toString("utf8");
  return output;
}

const claudeSse = await transformedText([
  upstreamSse.slice(0, 37),
  upstreamSse.slice(37, 211),
  upstreamSse.slice(211)
]);
assert.match(claudeSse, /event: message_start/);
assert.match(claudeSse, /"type":"thinking_delta","thinking":"Call the tool\."/);
assert.equal((claudeSse.match(/"type":"thinking_delta"/g) || []).length, 1);
assert.match(claudeSse, new RegExp(`"name":"${longToolName}"`));
assert.match(claudeSse, /"type":"input_json_delta","partial_json":"\{\\"path\\":\\"\/tmp\\"\}"/);
assert.match(claudeSse, /"stop_reason":"tool_use"/);
assert.match(claudeSse, /"cache_read_input_tokens":20/);
assert.match(claudeSse, /event: message_stop/);
assert.doesNotMatch(claudeSse, /response\.completed/);

const textResponse = {
  id: "resp_text",
  model: "grok-4.5",
  output: [{ id: "message_1", type: "message", content: [{ type: "output_text", text: "hello" }] }],
  usage: { input_tokens: 10, output_tokens: 2 }
};
const textSse = [
  upstreamEvent("response.created", { response: { id: "resp_text", model: "grok-4.5" } }),
  upstreamEvent("response.output_item.added", { output_index: 0, item: { id: "message_1", type: "message" } }),
  upstreamEvent("response.output_text.delta", { output_index: 0, item_id: "message_1", delta: "hello" }),
  upstreamEvent("response.output_item.done", { output_index: 0, item: textResponse.output[0] }),
  upstreamEvent("response.completed", { response: textResponse })
].join("");
const claudeTextSse = await transformedText([textSse]);
assert.equal((claudeTextSse.match(/"type":"text_delta"/g) || []).length, 1);
assert.match(claudeTextSse, /"stop_reason":"end_turn"/);

const truncatedSse = upstreamEvent("response.created", { response: { id: "resp_cut", model: "grok-4.5" } });
const claudeTruncatedSse = await transformedText([truncatedSse]);
assert.match(claudeTruncatedSse, /event: error/);
assert.match(claudeTruncatedSse, /ended before response\.completed/);

console.log("Claude Responses bridge tests passed.");
