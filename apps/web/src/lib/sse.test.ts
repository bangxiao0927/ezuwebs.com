import assert from "node:assert/strict";
import test from "node:test";

import { createSseParser } from "./sse.js";

test("feed emits one event per blank-line-terminated frame", () => {
  const parser = createSseParser();

  const events = parser.feed("id: 1\nevent: agent\ndata: {\"type\":\"message.delta\"}\n\n");

  assert.deepEqual(events, [{ id: "1", event: "agent", data: '{"type":"message.delta"}' }]);
});

test("feed buffers a frame split across chunks until the blank-line terminator arrives", () => {
  const parser = createSseParser();

  const first = parser.feed("id: 1\nevent: agent\ndata: {\"type\":\"mess");
  const second = parser.feed("age.delta\"}\n\n");

  assert.deepEqual(first, []);
  assert.deepEqual(second, [{ id: "1", event: "agent", data: '{"type":"message.delta"}' }]);
});

test("feed ignores a heartbeat comment frame", () => {
  const parser = createSseParser();

  const events = parser.feed(": heartbeat\n\n");

  assert.deepEqual(events, []);
});

test("feed reports multiple frames delivered in a single chunk, in order", () => {
  const parser = createSseParser();

  const events = parser.feed(
    "id: 1\nevent: agent\ndata: a\n\nid: 2\nevent: agent\ndata: b\n\n",
  );

  assert.deepEqual(events, [
    { id: "1", event: "agent", data: "a" },
    { id: "2", event: "agent", data: "b" },
  ]);
});

test("feed defaults the event name to message when the frame omits it", () => {
  const parser = createSseParser();

  const events = parser.feed("data: standalone\n\n");

  assert.deepEqual(events, [{ event: "message", data: "standalone" }]);
});
