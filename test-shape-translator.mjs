import assert from "node:assert/strict";
import {
  translateRequest,
  translateResponse,
  buildShapeBridge,
  SHAPE_TRANSLATOR_SUPPORTED,
  SHAPE_SSE_SUPPORTED
} from "./src/shape-translator.mjs";
import {
  responsesToGeminiRequest,
  messagesToGeminiRequest,
  chatToGeminiRequest,
  geminiRequestToResponsesRequest,
  prepareAntigravityBridge
} from "./src/antigravity-bridge.mjs";

// ---------- Fixtures ----------

const responsesReq = {
  model: "gpt-5.6-sol",
  instructions: "Be brief.",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] },
    { type: "function_call", call_id: "c1", name: "shell", arguments: "{\"path\":\"/tmp\"}" },
    { type: "function_call_output", call_id: "c1", output: "ok" }
  ],
  tools: [{
    type: "function",
    name: "shell",
    description: "Run a shell.",
    parameters: { type: "object", properties: { path: { type: "string" } } }
  }]
};

const chatReq = {
  model: "gpt-5.6-sol",
  messages: [
    { role: "system", content: "Be brief." },
    { role: "user", content: "Hello" }
  ]
};

const responsesToolPolicyReq = {
  model: "gpt-5.6-sol",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "use the tool" }] }],
  tools: [{ type: "function", name: "shell", description: "Run a shell", parameters: { type: "object" } }],
  tool_choice: { type: "function", name: "shell" },
  parallel_tool_calls: false,
  max_output_tokens: 321,
  top_p: 0.8,
  stream: true
};

const messagesReq = {
  model: "claude-sonnet-4-5",
  system: "Be brief.",
  messages: [
    { role: "user", content: "Hello" },
    { role: "assistant", content: [{ type: "text", text: "Hi." }] }
  ],
  max_tokens: 256
};

const geminiReq = {
  project: "",
  model: "gpt-5.6-sol",
  request: {
    systemInstruction: { role: "system", parts: [{ text: "Be brief." }] },
    contents: [
      { role: "user", parts: [{ text: "Hello" }] }
    ],
    generationConfig: { temperature: 0.2, maxOutputTokens: 256 }
  }
};

const samples = {
  responses: responsesReq,
  chat_completions: chatReq,
  messages: messagesReq,
  antigravity: geminiReq
};

// ---------- Supported pairs ----------

const expectedPairs = [
  "responses:chat_completions",
  "responses:messages",
  "responses:antigravity",
  "chat_completions:responses",
  "chat_completions:messages",
  "chat_completions:antigravity",
  "messages:responses",
  "messages:chat_completions",
  "messages:antigravity",
  "antigravity:responses",
  "antigravity:chat_completions",
  "antigravity:messages"
];

for (const pair of expectedPairs) {
  assert.ok(
    SHAPE_TRANSLATOR_SUPPORTED.requestPairs.includes(pair),
    `request pair ${pair} should be in requestPairs`
  );
}

// ---------- Request translation: all 12 pairs ----------

for (const [src, dst] of expectedPairs.map((s) => s.split(":"))) {
  const result = translateRequest(src, dst, samples[src]);
  assert.ok(result, `${src} -> ${dst} must produce a body`);
  if (dst === "antigravity") {
    assert.equal(result.project, "");
    assert.equal(typeof result.model, "string");
    assert.ok(result.request, "Gemini envelope must include request");
  } else if (dst === "responses") {
    assert.ok(Array.isArray(result.input) || typeof result.input === "undefined");
  } else if (dst === "chat_completions") {
    assert.ok(Array.isArray(result.messages));
  } else if (dst === "messages") {
    assert.ok(Array.isArray(result.messages));
  }
}

// ---------- Round-trip sanity: chat -> responses -> chat ----------

const chatRoundTrip = translateRequest(
  "chat_completions",
  "responses",
  translateRequest("responses", "chat_completions", responsesReq)
);
assert.equal(chatRoundTrip.model, responsesReq.model);
assert.ok(chatRoundTrip.input.length > 0);

// ---------- Responses <-> Antigravity tools/functions ----------

const agReq = translateRequest("responses", "antigravity", responsesReq);
assert.ok(Array.isArray(agReq.request.tools));
assert.equal(agReq.request.tools[0].functionDeclarations[0].name, "shell");
assert.equal(agReq.request.tools[0].functionDeclarations[0].parameters.type, "object");

const backToResponses = translateRequest("antigravity", "responses", agReq);
assert.ok(Array.isArray(backToResponses.tools));
assert.equal(backToResponses.tools[0].name, "shell");

// Responses -> Chat must preserve explicit tool policy during endpoint
// fallback.  Losing this field silently changes required/named calls to auto.
const chatToolPolicy = translateRequest("responses", "chat_completions", responsesToolPolicyReq);
assert.deepEqual(chatToolPolicy.tool_choice, {
  type: "function",
  function: { name: "shell" }
});
assert.equal(chatToolPolicy.parallel_tool_calls, false);
assert.equal(chatToolPolicy.max_tokens, 321);
assert.equal(chatToolPolicy.top_p, 0.8);

// ---------- Messages <-> Antigravity ----------

const agFromMessages = translateRequest("messages", "antigravity", messagesReq);
assert.equal(agFromMessages.model, "claude-sonnet-4-5");
assert.equal(agFromMessages.request.systemInstruction.parts[0].text, "Be brief.");
assert.equal(agFromMessages.request.contents[0].parts[0].text, "Hello");

const backToMessages = translateRequest("antigravity", "messages", agFromMessages);
assert.equal(backToMessages.model, "claude-sonnet-4-5");
assert.ok(Array.isArray(backToMessages.messages));
assert.equal(backToMessages.system, "Be brief.");

// ---------- Chat <-> Antigravity ----------

const agFromChat = translateRequest("chat_completions", "antigravity", chatReq);
assert.equal(agFromChat.request.contents[0].parts[0].text, "Hello");
assert.equal(agFromChat.request.systemInstruction.parts[0].text, "Be brief.");

const backToChat = translateRequest("antigravity", "chat_completions", agFromChat);
assert.ok(Array.isArray(backToChat.messages));
assert.equal(backToChat.messages[backToChat.messages.length - 1].content, "Hello");

// ---------- Response translation: antigravity -> {responses, chat, messages} ----------

const geminiResponse = {
  model: "gpt-5.6-sol",
  request: {
    candidates: [{
      finishReason: "STOP",
      content: { role: "model", parts: [{ text: "Hello there." }] }
    }],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 }
  }
};

for (const dst of ["responses", "chat_completions", "messages"]) {
  const result = translateResponse("antigravity", dst, geminiResponse, responsesReq);
  assert.ok(result, `antigravity -> ${dst} response must produce a body`);
  if (dst === "chat_completions") {
    assert.equal(result.choices[0].message.content, "Hello there.");
  } else if (dst === "messages") {
    assert.equal(result.content[0].text, "Hello there.");
  } else if (dst === "responses") {
    assert.equal(result.output[0].content[0].text, "Hello there.");
  }
}

// ---------- buildShapeBridge: X -> antigravity ----------

const vsllmTarget = {
  url: "https://vsllm.example.com/v1/responses",
  account: {
    alias: "vsllm",
    antigravity_base_url: "https://vsllm.example.com"
  }
};

for (const [clientShape, body] of [
  ["responses", responsesReq],
  ["chat_completions", chatReq],
  ["messages", messagesReq]
]) {
  const clientTarget = {
    ...vsllmTarget,
    url: `https://vsllm.example.com/v1/${
      clientShape === "responses" ? "responses" :
      clientShape === "chat_completions" ? "chat/completions" :
      "messages"
    }`
  };
  const bridge = buildShapeBridge({
    target: clientTarget,
    sourceShape: clientShape,
    targetShape: "antigravity",
    sourceBody: Buffer.from(JSON.stringify(body), "utf8")
  });
  assert.ok(bridge, `${clientShape} -> antigravity bridge must be built`);
  assert.equal(bridge.kind, "antigravity");
  assert.ok(bridge.target.url.includes(":streamGenerateContent"));
  assert.ok(bridge.body.length > 0);
}

// ---------- Identity short-circuit ----------

assert.deepEqual(translateRequest("responses", "responses", responsesReq), responsesReq);
assert.deepEqual(translateResponse("chat_completions", "chat_completions", { ok: 1 }, {}), { ok: 1 });

console.log(`shape-translator ok (12/12 request pairs, 3 antigravity->X response pairs, 3 bridge targets)`);
