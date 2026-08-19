import assert from "node:assert/strict";
import {
  prepareAntigravityBridge,
  responsesToGeminiRequest,
  messagesToGeminiRequest,
  chatToGeminiRequest,
  translateAntigravityResponseToShape
} from "./src/antigravity-bridge.mjs";

// ---------- Responses -> Gemini ----------

const responsesReq = {
  model: "gpt-5.6-sol",
  instructions: "Be brief.",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] },
    { type: "function_call", call_id: "c1", name: "shell", arguments: "{\"path\":\"/tmp\"}" },
    { type: "function_call_output", call_id: "c1", name: "shell", output: "ok" }
  ],
  tools: [{
    type: "function",
    name: "shell",
    description: "Run a shell.",
    parameters: { $schema: "x", type: "object", properties: { path: { type: "string" } }, required: ["path"] }
  }]
};

const agReq = responsesToGeminiRequest(responsesReq);
assert.equal(agReq.project, "");
assert.equal(agReq.model, "gpt-5.6-sol");
assert.equal(agReq.request.systemInstruction.parts[0].text, "Be brief.");
assert.equal(agReq.request.contents.length, 3);
assert.equal(agReq.request.contents[0].role, "user");
assert.equal(agReq.request.contents[0].parts[0].text, "Hello");
assert.equal(agReq.request.contents[1].parts[0].functionCall.name, "shell");
assert.deepEqual(agReq.request.contents[1].parts[0].functionCall.args, { path: "/tmp" });
assert.equal(agReq.request.contents[2].role, "user");
assert.ok(agReq.request.contents[2].parts[0].functionResponse);
assert.equal(agReq.request.tools.length, 1);
assert.equal(agReq.request.tools[0].functionDeclarations.length, 1);
assert.equal(agReq.request.tools[0].functionDeclarations[0].name, "shell");
assert.equal(agReq.request.tools[0].functionDeclarations[0].parameters.$schema, undefined);

// ---------- Messages -> Gemini ----------

const messagesReq = {
  model: "gpt-5.6-sol",
  system: [{ type: "text", text: "Be brief." }],
  messages: [
    { role: "user", content: [{ type: "text", text: "Hello" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "thinking" },
        { type: "tool_use", id: "tu_1", name: "shell", input: { path: "/tmp" } }
      ]
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_1", name: "shell", content: "ok" }
      ]
    }
  ],
  tools: [{
    name: "shell",
    description: "Run a shell.",
    input_schema: { type: "object", properties: { path: { type: "string" } } }
  }],
  max_tokens: 200
};
const agFromMessages = messagesToGeminiRequest(messagesReq);
assert.equal(agFromMessages.model, "gpt-5.6-sol");
assert.equal(agFromMessages.request.systemInstruction.parts[0].text, "Be brief.");
assert.equal(agFromMessages.request.contents.length, 3);
assert.equal(agFromMessages.request.contents[1].role, "model");
assert.ok(agFromMessages.request.contents[1].parts.some(p => p.functionCall));
assert.equal(agFromMessages.request.contents[2].role, "user");
assert.ok(agFromMessages.request.contents[2].parts[0].functionResponse);
assert.equal(agFromMessages.request.generationConfig.maxOutputTokens, 200);

// ---------- Chat -> Gemini ----------

const chatReq = {
  model: "gpt-5.6-sol",
  messages: [
    { role: "system", content: "Be brief." },
    { role: "user", content: "Hello" }
  ]
};
const agFromChat = chatToGeminiRequest(chatReq);
assert.equal(agFromChat.model, "gpt-5.6-sol");
assert.equal(agFromChat.request.contents[0].role, "user");
assert.equal(agFromChat.request.contents[0].parts[0].text, "Hello");
assert.equal(agFromChat.request.systemInstruction.parts[0].text, "Be brief.");

// ---------- Prepare bridge ----------

const bridgeTarget = {
  url: "https://vsllm.com/v1/responses",
  account: {
    alias: "vsllm",
    email: "vsllm@example.com",
    antigravity_base_url: "https://vsllm.com"
  }
};
const bridge = prepareAntigravityBridge(bridgeTarget, Buffer.from(JSON.stringify(responsesReq)));
assert.ok(bridge);
assert.equal(bridge.kind, "antigravity");
assert.equal(bridge.sourceShape, "responses");
assert.ok(bridge.target.url.includes(":streamGenerateContent"));
assert.ok(bridge.target.url.includes("gpt-5.6-sol"));

const chatBridge = prepareAntigravityBridge(
  { url: "https://vsllm.com/v1/chat/completions", account: bridgeTarget.account },
  Buffer.from(JSON.stringify(chatReq))
);
assert.ok(chatBridge);
assert.equal(chatBridge.sourceShape, "chat_completions");

// ---------- Response translation ----------

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
const responsesBack = translateAntigravityResponseToShape(geminiResponse, "responses");
assert.equal(responsesBack.kind, "responses");
assert.equal(responsesBack.body.output[0].content[0].text, "Hello there.");
assert.equal(responsesBack.body.usage.input_tokens, 7);
assert.equal(responsesBack.body.usage.output_tokens, 3);

const chatBack = translateAntigravityResponseToShape(geminiResponse, "chat_completions");
assert.equal(chatBack.kind, "chat_completions");
assert.equal(chatBack.body.choices[0].message.content, "Hello there.");
assert.equal(chatBack.body.choices[0].finish_reason, "stop");

const messagesBack = translateAntigravityResponseToShape(geminiResponse, "messages", messagesReq);
assert.equal(messagesBack.kind, "messages");
assert.equal(messagesBack.body.stop_reason, "end_turn");
assert.equal(messagesBack.body.content[0].text, "Hello there.");

console.log("antigravity bridge ok");
