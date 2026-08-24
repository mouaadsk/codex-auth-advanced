import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  createSseResponseTransformStream,
  ensureResponsesModel,
  inspectSsePreludeForModelCapacity
} from "./src/proxy-sse-transforms.mjs";

async function transformedText(chunks, isEventStream, fallbackModel) {
  const transform = createSseResponseTransformStream(
    { url: "https://provider.example/v1/responses" },
    isEventStream,
    null,
    { fallbackModel }
  );
  const output = [];
  for await (const chunk of Readable.from(chunks).pipe(transform)) {
    output.push(chunk);
  }
  return Buffer.concat(output).toString("utf8");
}

const created = {
  type: "response.created",
  response: {
    id: "resp_missing_model",
    object: "response",
    status: "in_progress",
    output: []
  }
};
const completed = {
  type: "response.completed",
  response: {
    id: "resp_missing_model",
    object: "response",
    status: "completed",
    output: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
  }
};
const streamText = [created, completed]
  .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  .join("");
const repairedStream = await transformedText(
  [streamText.slice(0, 79), streamText.slice(79)],
  true,
  "grok-4.6"
);
const repairedEvents = repairedStream
  .split(/\n\n/)
  .map((frame) => frame.split(/\r?\n/).find((line) => line.startsWith("data: ")))
  .filter(Boolean)
  .map((line) => JSON.parse(line.slice(6)));
assert.equal(repairedEvents.length, 2);
assert.equal(repairedEvents[0].response.model, "grok-4.6");
assert.equal(repairedEvents[1].response.model, "grok-4.6");

const upstreamModel = structuredClone(completed);
upstreamModel.response.model = "provider-model-id";
assert.equal(ensureResponsesModel(upstreamModel, "request-model-id"), false);
assert.equal(upstreamModel.response.model, "provider-model-id");

const unaryText = await transformedText([
  JSON.stringify({
    id: "resp_unary",
    object: "response",
    status: "completed",
    output: []
  })
], false, "grok-4.5");
assert.equal(JSON.parse(unaryText).model, "grok-4.5");

const noFallback = structuredClone(created);
assert.equal(ensureResponsesModel(noFallback, ""), false);
assert.equal("model" in noFallback.response, false);

function sseEvent(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const capacityPayload = {
  type: "error",
  error: {
    type: "service_unavailable",
    message: "Selected model is at capacity. Please try a different model.",
    codex_error_info: "server_overloaded"
  }
};
const capacitySse = [
  sseEvent("response.created", created),
  sseEvent("error", capacityPayload),
  sseEvent("response.failed", {
    type: "response.failed",
    response: {
      status: "failed",
      error: { code: "server_overloaded", message: "Please try a different model." }
    }
  })
].join("");

const capacityResponse = new Response(capacitySse, {
  status: 200,
  headers: { "content-type": "text/event-stream" }
});
const detectedCapacity = await inspectSsePreludeForModelCapacity(capacityResponse, { timeoutMs: 100 });
assert.equal(detectedCapacity.modelCapacity, true);
assert.equal(detectedCapacity.outcome, "model_capacity");
assert.equal(await capacityResponse.text(), capacitySse, "inspection must leave the original SSE response untouched");

for (const [label, outputEvent] of [
  ["text", sseEvent("response.output_text.delta", { type: "response.output_text.delta", delta: "hello" })],
  ["reasoning", sseEvent("response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", delta: "thinking" })],
  ["tool", sseEvent("response.custom_tool_call_input.delta", { type: "response.custom_tool_call_input.delta", delta: "{\"path\":" })],
  ["chat tool", `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "run" } }] } }] })}\n\n`]
]) {
  const body = outputEvent + sseEvent("error", capacityPayload);
  const response = new Response(body, { headers: { "content-type": "text/event-stream" } });
  const inspected = await inspectSsePreludeForModelCapacity(response, { timeoutMs: 100 });
  assert.equal(inspected.modelCapacity, false, `${label} output must disable transparent replay`);
  assert.equal(inspected.outcome, "output_started", `${label} output should end the retry prelude`);
  assert.equal(await response.text(), body, `${label} inspection must not consume the client response`);
}

const delayedBody = sseEvent("response.output_text.delta", { type: "response.output_text.delta", delta: "late" });
const delayedResponse = new Response(new ReadableStream({
  start(controller) {
    setTimeout(() => {
      controller.enqueue(new TextEncoder().encode(delayedBody));
      controller.close();
    }, 30);
  }
}), { headers: { "content-type": "text/event-stream" } });
const timedOutInspection = await inspectSsePreludeForModelCapacity(delayedResponse, { timeoutMs: 5 });
assert.equal(timedOutInspection.modelCapacity, false);
assert.equal(timedOutInspection.outcome, "timeout");
assert.equal(await delayedResponse.text(), delayedBody, "a timed-out inspection must leave the live response readable");

console.log("proxy-sse-transforms ok");
