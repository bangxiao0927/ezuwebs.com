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

test("streamChat surfaces the finish reason on an empty terminal frame", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    createStreamingResponse([
      toSse("hi"),
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n`,
      "data: [DONE]\n",
    ]);

  try {
    const client = createOpenAIClient({ apiKey: "test-key", baseUrl: "https://example.test" });
    const chunks = [];
    for await (const chunk of client.streamChat({
      model: "test-model",
      temperature: 0,
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    assert.deepEqual(
      chunks.map((chunk) => chunk.content),
      ["hi", ""],
    );
    assert.equal(chunks.at(-1)?.finishReason, "stop");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChat aborts the request when the timeout elapses", async () => {
  const originalFetch = globalThis.fetch;
  // Never resolve until the request signal aborts, simulating a stalled upstream.
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
        once: true,
      });
    })) as typeof globalThis.fetch;

  try {
    const client = createOpenAIClient({ apiKey: "test-key", baseUrl: "https://example.test" });
    await assert.rejects(async () => {
      for await (const _chunk of client.streamChat({
        model: "test-model",
        temperature: 0,
        messages: [{ role: "user", content: "hi" }],
        timeoutMs: 10,
      })) {
        // Drain; the stream should reject before yielding anything.
      }
    }, /timed out/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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

test("createOpenAIClient does not duplicate an existing chat completions path", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return createStreamingResponse(["data: [DONE]\n"]);
  };

  try {
    const client = createOpenAIClient({
      apiKey: "test-key",
      baseUrl: "https://example.test/v1/chat/completions/?api-version=latest#ignored",
    });
    for await (const _chunk of client.streamChat({
      model: "test-model",
      temperature: 0,
      messages: [{ role: "user", content: "hello" }],
    })) {
      // Drain the mocked stream to issue the request.
    }

    assert.equal(
      requestedUrl,
      "https://example.test/v1/chat/completions?api-version=latest",
    );
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

test("createRealModelGateway prefers a fenced block over trailing brace-heavy prose", async () => {
  const originalFetch = globalThis.fetch;
  // Trailing prose full of unbalanced/nested braces that would defeat a plain
  // brace scan; the fenced block must still win.
  const trailingNoise = Array.from(
    { length: 40 },
    (_v, i) => `note ${i}: {"k": {"nested": ${i}}}`,
  ).join(" ");
  const output = `Here is the plan.\n\`\`\`json\n${JSON.stringify({
    plan: [{ id: "step-1", title: "Do it", status: "pending" }],
    interaction: null,
  })}\n\`\`\`\n${trailingNoise}`;
  globalThis.fetch = async () =>
    createStreamingResponse([toSse(output), "data: [DONE]\n"]);

  try {
    const gateway = createRealModelGateway({
      clientConfig: { apiKey: "test-key", baseUrl: "https://example.test" },
    });
    const events = [];
    for await (const event of gateway.streamPlan({ prompt: "Do it" })) {
      events.push(event);
    }

    const planEvent = events.find((event) => event.type === "plan.updated");
    assert.ok(planEvent);
    assert.equal(planEvent.plan[0]?.id, "step-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createRealModelGateway warns when the response is truncated", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    createStreamingResponse([
      toSse("partial output with no closing JSON"),
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n`,
      "data: [DONE]\n",
    ]);

  try {
    const gateway = createRealModelGateway({
      clientConfig: { apiKey: "test-key", baseUrl: "https://example.test" },
    });
    const events = [];
    for await (const event of gateway.streamCode({ prompt: "Write a file" })) {
      events.push(event);
    }

    const warning = events.find(
      (event) => event.type === "message.delta" && event.text.includes("[warning]"),
    );
    assert.ok(warning, "expected a truncation warning delta");
    assert.ok(!events.some((event) => event.type === "action.created"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
