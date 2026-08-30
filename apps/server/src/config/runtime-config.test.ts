import assert from "node:assert/strict";
import test from "node:test";

import { resolveRuntimeProviderConfig, RuntimeConfigError } from "./runtime-config.js";

function remoteEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    RUNTIME_PROVIDER: "remote",
    RUNTIME_REMOTE_BASE_URL: "https://sandbox.internal.example.com",
    RUNTIME_REMOTE_TOKEN: "worker-token",
    RUNTIME_REMOTE_IMAGE: "node20",
    RUNTIME_REMOTE_COMMAND_POLICY: "network-deny",
    RUNTIME_REMOTE_PREVIEW_BASE_URL: "https://preview.internal.example.com",
    ...overrides,
  };
}

test("resolveRuntimeProviderConfig defaults to the in-process browser runtime", () => {
  const config = resolveRuntimeProviderConfig({}, { billingEnabled: false });
  assert.equal(config.provider, "browser");
});

test("resolveRuntimeProviderConfig builds a remote config when fully configured with billing enabled", () => {
  const config = resolveRuntimeProviderConfig(remoteEnv(), { billingEnabled: true });
  assert.equal(config.provider, "remote");
  if (config.provider === "remote") {
    assert.equal(config.remote.baseUrl, "https://sandbox.internal.example.com");
    assert.equal(config.remote.apiToken, "worker-token");
    assert.equal(config.remote.image, "node20");
    assert.equal(config.remote.previewBaseUrl, "https://preview.internal.example.com");
  }
});

test("resolveRuntimeProviderConfig refuses a remote runtime when billing/auth is disabled", () => {
  assert.throws(
    () => resolveRuntimeProviderConfig(remoteEnv(), { billingEnabled: false }),
    RuntimeConfigError,
  );
});

for (const missingVar of [
  "RUNTIME_REMOTE_BASE_URL",
  "RUNTIME_REMOTE_TOKEN",
  "RUNTIME_REMOTE_IMAGE",
  "RUNTIME_REMOTE_COMMAND_POLICY",
  "RUNTIME_REMOTE_PREVIEW_BASE_URL",
]) {
  test(`resolveRuntimeProviderConfig requires ${missingVar} for the remote provider`, () => {
    assert.throws(
      () => resolveRuntimeProviderConfig(remoteEnv({ [missingVar]: undefined }), { billingEnabled: true }),
      RuntimeConfigError,
    );
  });
}

test("resolveRuntimeProviderConfig rejects an unsupported command policy value", () => {
  assert.throws(
    () =>
      resolveRuntimeProviderConfig(remoteEnv({ RUNTIME_REMOTE_COMMAND_POLICY: "allow-anything" }), {
        billingEnabled: true,
      }),
    RuntimeConfigError,
  );
});

test("resolveRuntimeProviderConfig rejects an unknown RUNTIME_PROVIDER value", () => {
  assert.throws(
    () => resolveRuntimeProviderConfig({ RUNTIME_PROVIDER: "vm" }, { billingEnabled: true }),
    RuntimeConfigError,
  );
});

test("resolveRuntimeProviderConfig rejects a non-https base URL before the server ever listens", () => {
  assert.throws(
    () =>
      resolveRuntimeProviderConfig(remoteEnv({ RUNTIME_REMOTE_BASE_URL: "http://sandbox.internal.example.com" }), {
        billingEnabled: true,
      }),
    RuntimeConfigError,
  );
});

test("resolveRuntimeProviderConfig rejects a malformed preview base URL before the server ever listens", () => {
  assert.throws(
    () =>
      resolveRuntimeProviderConfig(remoteEnv({ RUNTIME_REMOTE_PREVIEW_BASE_URL: "not-a-url" }), {
        billingEnabled: true,
      }),
    RuntimeConfigError,
  );
});
