import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAIClient } from "./openai-client.js";
import { createRealModelGateway } from "./real-gateway.js";

function createStreamingResponse(parts: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(encoder.encode(part));
        }
        controller.close();
      },
    }),
    { status: 200 },
  );
}

function toSse(content: string, trailingNewline = true): string {
  const data = JSON.stringify({
    choices: [{ delta: { content }, finish_reason: null }],
  });
  return `data: ${data}${trailingNewline ? "\n" : ""}`;
}

test("createOpenAIClient accepts a base URL ending in /v1 and parses a final SSE line", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return createStreamingResponse([toSse("hello", false)]);
  };

  try {
    const client = createOpenAIClient({
      apiKey: "test-key",
      baseUrl: "https://example.test/v1/",
    });
    const chunks = [];
    for await (const chunk of client.streamChat({
      model: "test-model",
      temperature: 0,
      messages: [{ role: "user", content: "hello" }],
    })) {
      chunks.push(chunk.content);
    }

    assert.equal(requestedUrl, "https://example.test/v1/chat/completions");
    assert.deepEqual(chunks, ["hello"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRealModelGateway parses pretty-printed JSON from streamed model output", async () => {
  const originalFetch = globalThis.fetch;
  const structuredOutput = `Planning code such as function demo() { before responding.\n\`\`\`json\n${JSON.stringify(
    {
      plan: [
        {
          id: "step-1",
          title: "Update the page",
          description: "Apply the requested change",
          status: "pending",
        },
      ],
      interaction: null,
    },
    null,
    2,
  )}\n\`\`\`\nFor example, an unrelated object may look like {"id":"example"}.`;
  globalThis.fetch = async () =>
    createStreamingResponse([
      toSse(structuredOutput.slice(0, 40)),
      toSse(structuredOutput.slice(40)),
      "data: [DONE]\n",
    ]);

  try {
    const gateway = createRealModelGateway({
      clientConfig: { apiKey: "test-key", baseUrl: "https://example.test" },
    });
    const events = [];
    for await (const event of gateway.streamPlan({ prompt: "Update the page" })) {
      events.push(event);
    }

    const planEvent = events.find((event) => event.type === "plan.updated");
    assert.ok(planEvent);
    assert.equal(planEvent.plan[0]?.id, "step-1");
    assert.equal(planEvent.plan[0]?.title, "Update the page");
    assert.equal(events.at(-1)?.type, "message.completed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
