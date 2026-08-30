import assert from "node:assert/strict";
import test from "node:test";

import { validateRemoteRuntimeConfig } from "./config.js";
import { RemoteRuntimeConfigError } from "./errors.js";

function baseConfig() {
  return {
    baseUrl: "https://sandbox.example.com/internal",
    apiToken: "token-123",
    sessionId: "session-a",
    projectId: "project-a",
    image: "node20",
    profile: "default",
  };
}

test("validateRemoteRuntimeConfig accepts a well-formed https config and fills in defaults", () => {
  const config = validateRemoteRuntimeConfig(baseConfig());

  assert.equal(config.baseUrl, "https://sandbox.example.com/internal");
  assert.equal(config.connectTimeoutMs > 0, true);
  assert.equal(config.readTimeoutMs > 0, true);
  assert.equal(config.commandTimeoutMs > 0, true);
  assert.equal(config.pollIntervalMs > 0, true);
  assert.equal(config.networkEgressDeny, true);
});

test("validateRemoteRuntimeConfig rejects a plain http baseUrl", () => {
  assert.throws(
    () => validateRemoteRuntimeConfig({ ...baseConfig(), baseUrl: "http://sandbox.example.com" }),
    RemoteRuntimeConfigError,
  );
});

test("validateRemoteRuntimeConfig allows http only for explicit loopback hosts with allowInsecureLoopback", () => {
  const config = validateRemoteRuntimeConfig({
    ...baseConfig(),
    baseUrl: "http://127.0.0.1:4390",
    allowInsecureLoopback: true,
  });

  assert.equal(config.baseUrl, "http://127.0.0.1:4390");
});

test("validateRemoteRuntimeConfig rejects http on a non-loopback host even with allowInsecureLoopback", () => {
  assert.throws(
    () =>
      validateRemoteRuntimeConfig({
        ...baseConfig(),
        baseUrl: "http://sandbox.example.com",
        allowInsecureLoopback: true,
      }),
    RemoteRuntimeConfigError,
  );
});

test("validateRemoteRuntimeConfig rejects a baseUrl carrying credentials", () => {
  assert.throws(
    () => validateRemoteRuntimeConfig({ ...baseConfig(), baseUrl: "https://user:pass@sandbox.example.com" }),
    RemoteRuntimeConfigError,
  );
});

test("validateRemoteRuntimeConfig rejects a baseUrl carrying a query string", () => {
  assert.throws(
    () => validateRemoteRuntimeConfig({ ...baseConfig(), baseUrl: "https://sandbox.example.com?debug=1" }),
    RemoteRuntimeConfigError,
  );
});

test("validateRemoteRuntimeConfig rejects a baseUrl carrying a hash fragment", () => {
  assert.throws(
    () => validateRemoteRuntimeConfig({ ...baseConfig(), baseUrl: "https://sandbox.example.com#frag" }),
    RemoteRuntimeConfigError,
  );
});

test("validateRemoteRuntimeConfig rejects a malformed baseUrl", () => {
  assert.throws(
    () => validateRemoteRuntimeConfig({ ...baseConfig(), baseUrl: "not-a-url" }),
    RemoteRuntimeConfigError,
  );
});

test("validateRemoteRuntimeConfig rejects blank required identifiers", () => {
  assert.throws(
    () => validateRemoteRuntimeConfig({ ...baseConfig(), sessionId: "" }),
    RemoteRuntimeConfigError,
  );
  assert.throws(
    () => validateRemoteRuntimeConfig({ ...baseConfig(), apiToken: "" }),
    RemoteRuntimeConfigError,
  );
});

test("validateRemoteRuntimeConfig validates previewBaseUrl with the same scheme rules as baseUrl", () => {
  assert.throws(
    () => validateRemoteRuntimeConfig({ ...baseConfig(), previewBaseUrl: "http://preview.example.com" }),
    RemoteRuntimeConfigError,
  );

  const config = validateRemoteRuntimeConfig({
    ...baseConfig(),
    previewBaseUrl: "https://preview.example.com",
  });
  assert.equal(config.previewBaseUrl, "https://preview.example.com");
});
