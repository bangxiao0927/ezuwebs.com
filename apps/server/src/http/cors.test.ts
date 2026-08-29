import test from "node:test";
import assert from "node:assert/strict";

import { corsHeaders, resolveAllowedOrigin } from "./cors.js";

test("resolveAllowedOrigin returns undefined for a same-origin request (no cross-origin WEB_APP_URL configured)", () => {
  delete process.env["WEB_APP_URL"];
  assert.equal(resolveAllowedOrigin("https://ezuwebs.com"), undefined);
});

test("resolveAllowedOrigin returns undefined when there is no Origin header", () => {
  process.env["WEB_APP_URL"] = "https://app.ezuwebs.com";
  assert.equal(resolveAllowedOrigin(undefined), undefined);
  delete process.env["WEB_APP_URL"];
});

test("resolveAllowedOrigin echoes the exact configured cross-origin WEB_APP_URL origin", () => {
  process.env["WEB_APP_URL"] = "https://app.ezuwebs.com";
  assert.equal(resolveAllowedOrigin("https://app.ezuwebs.com"), "https://app.ezuwebs.com");
  delete process.env["WEB_APP_URL"];
});

test("resolveAllowedOrigin rejects an origin that does not match WEB_APP_URL", () => {
  process.env["WEB_APP_URL"] = "https://app.ezuwebs.com";
  assert.equal(resolveAllowedOrigin("https://evil.example.com"), undefined);
  delete process.env["WEB_APP_URL"];
});

test("corsHeaders is empty when there is no allowed origin", () => {
  assert.deepEqual(corsHeaders(undefined), {});
});

test("corsHeaders includes credentials and Vary: Origin for an allowed cross-origin request", () => {
  const headers = corsHeaders("https://app.ezuwebs.com");
  assert.equal(headers["access-control-allow-origin"], "https://app.ezuwebs.com");
  assert.equal(headers["access-control-allow-credentials"], "true");
  assert.equal(headers["vary"], "Origin");
});
