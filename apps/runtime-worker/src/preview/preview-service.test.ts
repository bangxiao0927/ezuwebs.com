import assert from "node:assert/strict";
import { test } from "node:test";

import { PreviewPortNotAllowedError, PreviewService } from "./preview-service.js";

function newService(overrides: Partial<{ allowedPorts: number[]; ttlMs: number }> = {}) {
  return new PreviewService({
    publicBaseUrl: "https://preview.example.com",
    allowedPorts: [4173, 4174, 4175],
    ttlMs: 1000,
    ...overrides,
  });
}

test("issue() returns an opaque token URL under the configured public base", () => {
  const service = newService();
  const preview = service.issue("rt1");
  assert.match(preview.url, /^https:\/\/preview\.example\.com\/p\/[A-Za-z0-9_-]{16,}\/$/);
  assert.equal(preview.status, "open");
});

test("issue() rejects a port outside the configured allowlist", () => {
  const service = newService();
  assert.throws(() => service.issue("rt1", 9999), PreviewPortNotAllowedError);
});

test("resolve() maps a token back to its runtime and mode until it expires", () => {
  const service = newService({ ttlMs: 10 });
  const preview = service.issue("rt1");
  const token = preview.url.split("/p/")[1]!.replace(/\/$/, "");

  const resolved = service.resolve(token);
  assert.equal(resolved?.runtimeId, "rt1");
  assert.equal(resolved?.mode, "static");
});

test("resolve() returns undefined for an unknown or expired token", async () => {
  const service = newService({ ttlMs: 1 });
  const preview = service.issue("rt1");
  const token = preview.url.split("/p/")[1]!.replace(/\/$/, "");

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(service.resolve(token), undefined);
  assert.equal(service.resolve("unknown-token"), undefined);
});

test("disposeForRuntime() immediately invalidates every token for that runtime", () => {
  const service = newService();
  const preview = service.issue("rt1");
  const token = preview.url.split("/p/")[1]!.replace(/\/$/, "");

  service.disposeForRuntime("rt1");

  assert.equal(service.resolve(token), undefined);
});
