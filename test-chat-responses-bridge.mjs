import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  prepareChatResponsesBridge,
  retargetChatResponsesBridge,
  translateChatCompletionsRequestToResponses,
  translateResponsesResponseToChat
} from "./src/chat-responses-core.mjs";

const chatRequest = {
  model: "grok-4.5",
  stream: true,
  temperature: 0.7,
  messages: [
    { role: "system", content: "You are a careful assistant." },
    { role: "user", content: [{ type: "text", text: "Inspect /tmp." }] },
    {
      role: "assistant",
      content: "Need the tool.",
      tool_calls: [{
        id: "call_xyz",
        type: "function",
        function: { name: "shell", arguments: "{\"path\":\"/tmp\"}" }
      }]
    },
    {
      role: "tool",
      tool_call_id: "call_xyz",
      content: [{ type: "text", text: "ok" }]
    }
  ],
  tools: [{
    type: "function",
    function: {
      name: "shell",
      description: "Run a shell command.",
      parameters: { $schema: "x", type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    }
  }],
  tool_choice: { type: "function", function: { name: "shell" } },
  reasoning_effort: "high"
};

const responses = translateChatCompletionsRequestToResponses(chatRequest);
assert.equal(responses.model, "grok-4.5");
assert.equal(responses.stream, true);
assert.equal(responses.parallel_tool_calls, true);
assert.equal(responses.store, false);
assert.equal(responses.reasoning.effort, "high");
assert.equal(responses.reasoning.summary, "auto");
assert.equal(responses.tools.length, 1);
assert.ok(responses.tools[0].name.length <= 64);
assert.equal(responses.tools[0].parameters.$schema, undefined);
assert.equal(responses.tool_choice.function?.name, responses.tools[0].name);
assert.equal(typeof responses.instructions, "string");
assert.ok(responses.instructions.includes("careful assistant"));
const toolCall = responses.input.find((item) => item.type === "function_call");
const toolResult = responses.input.find((item) => item.type === "function_call_output");
assert.ok(toolCall);
assert.ok(toolResult);
assert.ok(toolCall.call_id.length <= 64);
assert.equal(toolCall.call_id, toolResult.call_id);
assert.equal(toolCall.name, responses.tools[0].name);
assert.deepEqual(JSON.parse(toolCall.arguments), { path: "/tmp" });

// Image round-trip
const imageOnly = translateChatCompletionsRequestToResponses({
  model: "grok-4.5",
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "https://example.com/a.png" } }
    ]
  }]
});
assert.equal(imageOnly.input[0].role, "user");
assert.equal(imageOnly.input[0].content[0].type, "input_text");
assert.equal(imageOnly.input[0].content[1].type, "input_image");
assert.equal(imageOnly.input[0].content[1].image_url, "https://example.com/a.png");

// Auto tool_choice should stay auto (no tool_choice key emitted)
const autoChoice = translateChatCompletionsRequestToResponses({
  model: "grok-4.5",
  tool_choice: "auto",
  messages: [{ role: "user", content: "hi" }]
});
assert.equal(autoChoice.tool_choice, undefined);

// Chat -> Responses bridge target rewrite
const bridgeTarget = {
  url: "https://vsllm.com/v1/chat/completions?beta=true",
  upstreamBaseUrl: "https://vsllm.com",
  account: { alias: "vsllm", email: "vsllm@example.com" }
};
const prepared = prepareChatResponsesBridge(bridgeTarget, Buffer.from(JSON.stringify(chatRequest)));
assert.ok(prepared);
assert.equal(prepared.kind, "responses");
assert.equal(prepared.sourceShape, "chat_completions");
assert.ok(prepared.target.url.endsWith("/v1/responses"));
assert.equal(prepared.target.chatResponsesBridge, true);

const retargeted = retargetChatResponsesBridge({ url: "https://vsllm.com/v1/chat/completions" }, prepared);
assert.ok(retargeted.url.endsWith("/v1/responses"));

// Responses -> Chat reverse translation
const responsesPayload = {
  type: "response.completed",
  response: {
    id: "resp_1",
    object: "response",
    model: "grok-4.5",
    output: [
      { type: "reasoning", summary: [{ text: "thinking..." }] },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Hello there." }]
      }
    ],
    usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
    stop_reason: "end_turn"
  }
};
const chatPayload = translateResponsesResponseToChat(responsesPayload);
assert.ok(chatPayload);
assert.equal(chatPayload.object, "chat.completion");
assert.equal(chatPayload.model, "grok-4.5");
assert.equal(chatPayload.choices[0].message.role, "assistant");
assert.equal(chatPayload.choices[0].message.content, "Hello there.");
assert.equal(chatPayload.choices[0].finish_reason, "stop");
assert.equal(chatPayload.usage.prompt_tokens, 12);
assert.equal(chatPayload.usage.completion_tokens, 5);
assert.equal(chatPayload.usage.total_tokens, 17);

// Function-call response -> Chat with tool_calls
const fcPayload = {
  type: "response.completed",
  response: {
    id: "resp_2",
    model: "grok-4.5",
    output: [{
      type: "function_call",
      call_id: "call_abc",
      name: "shell",
      arguments: "{\"path\":\"/tmp\"}"
    }],
    usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 },
    stop_reason: "tool_use"
  }
};
const fcChat = translateResponsesResponseToChat(fcPayload);
assert.ok(fcChat);
assert.equal(fcChat.choices[0].finish_reason, "tool_calls");
assert.equal(fcChat.choices[0].message.tool_calls.length, 1);
assert.equal(fcChat.choices[0].message.tool_calls[0].id, "call_abc");
assert.equal(fcChat.choices[0].message.tool_calls[0].function.name, "shell");

// Streaming smoke: feed an SSE buffer through the stream and ensure we get a Chat chunk back.
import { createChatCompletionsSseTransformStream } from "./src/chat-responses-sse.mjs";
const sseSource = [
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_3","model":"grok-4.5","output":[]}}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_3","model":"grok-4.5","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hi"}]}],"usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3},"stop_reason":"end_turn"}}\n\n'
].join("");
const stream = Readable.from([Buffer.from(sseSource, "utf8")]).pipe(createChatCompletionsSseTransformStream({ model: "grok-4.5" }));
let collected = "";
for await (const chunk of stream) collected += chunk.toString("utf8");
assert.match(collected, /chat\.completion\.chunk/);
assert.match(collected, /\[DONE\]/);

console.log("chat responses bridge ok");
