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

test("a seeded runtime previews the file most recently changed, not the last sorted path", async () => {
  const runtime = new BrowserRuntimeStub([
    { path: "src/App.tsx", content: "old app" },
    { path: "tsconfig.json", content: "should not be the active preview" },
  ]);

  await runtime.patchFile("src/App.tsx", "updated app");
  const preview = await runtime.openPreview(4174);
  const html = decodePreview(preview.url);

  assert.match(html, /src\/App\.tsx/);
  assert.match(html, /updated app/);
  assert.doesNotMatch(html, /<h1>tsconfig\.json<\/h1>/);
});

test("seeded files are readable and listed without any writes", async () => {
  const runtime = new BrowserRuntimeStub([
    { path: "src/App.tsx", content: "export const App = 1;" },
    { path: "README.md", content: "# Hello" },
  ]);

  assert.equal(await runtime.readFile("src/App.tsx"), "export const App = 1;");
  assert.deepEqual(await runtime.listFiles(""), ["README.md", "src/App.tsx"]);
});

test("patching a seeded file preserves its prior content instead of starting from empty", async () => {
  const runtime = new BrowserRuntimeStub([{ path: "src/App.tsx", content: "const seeded = true;" }]);

  await runtime.patchFile("src/App.tsx", "// appended patch");

  assert.equal(await runtime.readFile("src/App.tsx"), "const seeded = true;\n// appended patch");
});
