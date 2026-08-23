import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  createSseResponseTransformStream,
  ensureResponsesModel
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

console.log("proxy-sse-transforms ok");
