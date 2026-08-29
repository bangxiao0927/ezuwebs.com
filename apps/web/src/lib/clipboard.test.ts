import assert from "node:assert/strict";
import test from "node:test";

import { copyText } from "./clipboard.js";

test("copying an empty value fails without touching the clipboard", async () => {
  let writeCalls = 0;
  const writer = {
    writeText: async () => {
      writeCalls += 1;
    },
  };

  const result = await copyText(writer, "   ", "file path");

  assert.equal(result.ok, false);
  assert.equal(result.message, "No file path to copy.");
  assert.equal(writeCalls, 0);
});

test("copying a non-empty value writes the trimmed text to the clipboard", async () => {
  const written: string[] = [];
  const writer = {
    writeText: async (text: string) => {
      written.push(text);
    },
  };

  const result = await copyText(writer, "  /src/App.vue  ", "file path");

  assert.equal(result.ok, true);
  assert.equal(result.message, "Copied file path.");
  assert.deepEqual(written, ["/src/App.vue"]);
});

test("a clipboard write failure is reported without throwing", async () => {
  const writer = {
    writeText: async () => {
      throw new Error("denied");
    },
  };

  const result = await copyText(writer, "https://example.test/preview", "preview URL");

  assert.equal(result.ok, false);
  assert.equal(result.message, "Failed to copy preview URL.");
});

test("copying without a clipboard writer available fails gracefully", async () => {
  const result = await copyText(undefined, "some content", "file content");

  assert.equal(result.ok, false);
  assert.equal(result.message, "Clipboard is not available in this browser.");
});
