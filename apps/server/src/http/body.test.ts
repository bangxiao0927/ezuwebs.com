import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";

import { PayloadTooLargeError, readJsonBody } from "./body.js";

function fakeRequest(body: string): IncomingMessage {
  const stream = Readable.from([Buffer.from(body, "utf8")]);
  return stream as unknown as IncomingMessage;
}

test("readJsonBody parses a normal JSON body", async () => {
  const result = await readJsonBody<{ text: string }>(fakeRequest(JSON.stringify({ text: "hi" })));
  assert.deepEqual(result, { text: "hi" });
});

test("readJsonBody returns an empty object for an empty body", async () => {
  const result = await readJsonBody<Record<string, unknown>>(fakeRequest(""));
  assert.deepEqual(result, {});
});

test("readJsonBody rejects a body larger than the configured limit", async () => {
  const oversized = JSON.stringify({ text: "x".repeat(100) });
  await assert.rejects(readJsonBody(fakeRequest(oversized), 10), PayloadTooLargeError);
});
