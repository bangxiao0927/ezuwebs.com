import assert from "node:assert/strict";
import test from "node:test";

import { BrowserRuntimeStub } from "./index.js";

function decodePreview(url: string): string {
  const prefix = "data:text/html;charset=utf-8,";
  assert.ok(url.startsWith(prefix), `expected a browser-readable data URL, got ${url.slice(0, 32)}`);
  return decodeURIComponent(url.slice(prefix.length));
}

test("openPreview returns browser-readable HTML instead of a process-local blob URL", async () => {
  const runtime = new BrowserRuntimeStub();
  await runtime.writeFile("index.html", "<main>Hello preview</main>");

  const preview = await runtime.openPreview(4174);

  assert.equal(preview.status, "open");
  assert.doesNotMatch(preview.url, /^blob:nodedata:/);
  assert.match(decodePreview(preview.url), /Hello preview/);
});

test("file changes refresh an open preview and notify port watchers", async () => {
  const runtime = new BrowserRuntimeStub();
  const events: Array<{ port: number; url: string; status: "open" | "close" }> = [];
  await runtime.watchPorts((event) => events.push(event));
  await runtime.writeFile("index.html", "<main>First revision</main>");
  const first = await runtime.openPreview(4174);

  await runtime.writeFile("index.html", "<main>Second revision</main>");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const latest = events.at(-1);
  assert.ok(latest);
  assert.equal(latest.status, "open");
  assert.notEqual(latest.url, first.url);
  assert.match(decodePreview(latest.url), /Second revision/);
});
