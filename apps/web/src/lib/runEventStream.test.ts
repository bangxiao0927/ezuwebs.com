import assert from "node:assert/strict";
import test from "node:test";

import { openRunEventStream } from "./runEventStream.js";
import type { RunEventDto } from "../types";

function sseBody(frames: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(frames));
      controller.close();
    },
  });
}

function agentFrame(seq: number, event: unknown): string {
  return `id: ${seq}\nevent: agent\ndata: ${JSON.stringify(event)}\n\n`;
}

function waitForCalls(getCount: () => number, expected: number, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (getCount() >= expected) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitForCalls timed out"));
      setTimeout(check, 5);
    };
    check();
  });
}

test("delivers replayed events in order and stops once the run reaches a terminal status", async () => {
  const calls: string[] = [];
  const events: RunEventDto[] = [];
  const statuses: string[] = [];

  const fetchImpl = async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/events")) {
      return new Response(
        sseBody(agentFrame(1, { type: "message.delta", messageId: "m1", text: "hi" })),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ run: { id: "run-1", sessionId: "s1", status: "completed", lastEventSeq: 1 } }), {
      status: 200,
    });
  };

  const handle = openRunEventStream(
    "s1",
    "run-1",
    {
      onEvent: (entry) => events.push(entry),
      onStatus: (status) => statuses.push(status),
    },
    { fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: async () => undefined },
  );

  await waitForCalls(() => statuses.length, 1);
  handle.close();

  assert.deepEqual(events, [{ seq: 1, event: { type: "message.delta", messageId: "m1", text: "hi" } }]);
  assert.deepEqual(statuses, ["completed"]);
  assert.equal(calls.filter((url) => url.includes("/events")).length, 1);
});

test("reconnects with the last seen seq after a non-terminal disconnect, and dedupes replayed events", async () => {
  const events: RunEventDto[] = [];
  const statuses: string[] = [];
  const reconnectAttempts: number[] = [];
  const sleeps: number[] = [];
  let eventsRequestCount = 0;

  const fetchImpl = async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/events")) {
      eventsRequestCount += 1;
      if (eventsRequestCount === 1) {
        // The first connection replays seq 1 then drops before the run finished.
        return new Response(sseBody(agentFrame(1, { type: "message.delta", messageId: "m1", text: "hi" })), {
          status: 200,
        });
      }
      assert.ok(url.includes("afterSeq=1"), `expected reconnect to resume after seq 1, got ${url}`);
      return new Response(
        sseBody(
          agentFrame(1, { type: "message.delta", messageId: "m1", text: "hi" }) +
            agentFrame(2, { type: "message.completed", messageId: "m1" }),
        ),
        { status: 200 },
      );
    }
    const status = eventsRequestCount < 2 ? "running" : "completed";
    return new Response(JSON.stringify({ run: { id: "run-1", sessionId: "s1", status, lastEventSeq: 2 } }), {
      status: 200,
    });
  };

  const handle = openRunEventStream(
    "s1",
    "run-1",
    {
      onEvent: (entry) => events.push(entry),
      onStatus: (status) => statuses.push(status),
      onReconnecting: (attempt) => reconnectAttempts.push(attempt),
    },
    {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    },
  );

  await waitForCalls(() => statuses.length, 2);
  handle.close();

  assert.deepEqual(events.map((entry) => entry.seq), [1, 2]);
  assert.deepEqual(statuses, ["running", "completed"]);
  assert.deepEqual(reconnectAttempts, [1]);
  assert.deepEqual(sleeps, [500]);
});

test("close() aborts the in-flight request without calling cancel or reconnecting", async () => {
  const statuses: string[] = [];
  let aborted = false;

  const fetchImpl = async (_input: string | URL, init?: RequestInit) => {
    const signal = init?.signal;
    return new Response(
      new ReadableStream({
        start(controller) {
          signal?.addEventListener("abort", () => {
            aborted = true;
            controller.error(new Error("aborted"));
          });
        },
      }),
      { status: 200 },
    );
  };

  const handle = openRunEventStream(
    "s1",
    "run-1",
    {
      onEvent: () => undefined,
      onStatus: (status) => statuses.push(status),
    },
    { fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: async () => undefined },
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  handle.close();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(aborted, true);
  assert.deepEqual(statuses, []);
});

test("terminates without reconnecting when the run status fetch reports 404", async () => {
  const statuses: string[] = [];
  const errors: Error[] = [];
  const reconnectAttempts: number[] = [];

  const fetchImpl = async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/events")) {
      return new Response(sseBody(""), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  const handle = openRunEventStream(
    "s1",
    "run-1",
    {
      onEvent: () => undefined,
      onStatus: (status) => statuses.push(status),
      onReconnecting: (attempt) => reconnectAttempts.push(attempt),
      onError: (error) => errors.push(error),
    },
    { fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: async () => undefined },
  );

  await waitForCalls(() => errors.length, 1);
  handle.close();

  assert.deepEqual(statuses, []);
  assert.deepEqual(reconnectAttempts, []);
  assert.match(errors[0]?.message ?? "", /404/);
});

test("bounds reconnect attempts on a persistent 5xx status failure and reports an error instead of retrying forever", async () => {
  const errors: Error[] = [];
  const reconnectAttempts: number[] = [];
  const sleeps: number[] = [];

  const fetchImpl = async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/events")) {
      return new Response(sseBody(""), { status: 200 });
    }
    return new Response("server error", { status: 503 });
  };

  const handle = openRunEventStream(
    "s1",
    "run-1",
    {
      onEvent: () => undefined,
      onStatus: () => undefined,
      onReconnecting: (attempt) => reconnectAttempts.push(attempt),
      onError: (error) => errors.push(error),
    },
    {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async (ms) => sleeps.push(ms),
      maxReconnectAttempts: 3,
    },
  );

  await waitForCalls(() => errors.length, 1);
  handle.close();

  assert.deepEqual(reconnectAttempts, [1, 2, 3]);
  assert.equal(sleeps.length, 3);
  assert.match(errors[0]?.message ?? "", /503/);
});

test("resets the reconnect attempt counter after a frame is delivered", async () => {
  const reconnectAttempts: number[] = [];
  const statuses: string[] = [];
  let eventsRequestCount = 0;

  const fetchImpl = async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/events")) {
      eventsRequestCount += 1;
      if (eventsRequestCount <= 2) {
        // Every connection attempt drops immediately without ever
        // delivering a frame, so the attempt counter must keep climbing.
        return new Response(sseBody(""), { status: 200 });
      }
      if (eventsRequestCount === 3) {
        // This connection delivers a frame before dropping, which must
        // reset the counter back to 0 for the next reconnect.
        return new Response(sseBody(agentFrame(1, { type: "message.delta", messageId: "m1", text: "hi" })), {
          status: 200,
        });
      }
      return new Response(
        sseBody(agentFrame(2, { type: "message.completed", messageId: "m1" })),
        { status: 200 },
      );
    }
    const status = eventsRequestCount < 4 ? "running" : "completed";
    return new Response(JSON.stringify({ run: { id: "run-1", sessionId: "s1", status, lastEventSeq: 2 } }), {
      status: 200,
    });
  };

  const handle = openRunEventStream(
    "s1",
    "run-1",
    {
      onEvent: () => undefined,
      onStatus: (status) => statuses.push(status),
      onReconnecting: (attempt) => reconnectAttempts.push(attempt),
    },
    { fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: async () => undefined },
  );

  await waitForCalls(() => statuses.length, 4);
  handle.close();

  assert.deepEqual(reconnectAttempts, [1, 2, 1]);
});
