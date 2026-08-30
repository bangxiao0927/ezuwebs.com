import assert from "node:assert/strict";
import { test } from "node:test";

import { WorkerConfigError, loadWorkerConfig } from "./config.js";

const strongToken = "a".repeat(32);

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    WORKER_API_TOKEN: strongToken,
    WORKER_ROOT: "/var/lib/runtime-worker",
    WORKER_PUBLIC_PREVIEW_BASE_URL: "https://preview.example.com",
    WORKER_ALLOWED_IMAGES: "ezu/sandbox:frontend",
    WORKER_DOCKER_BIN: "/usr/bin/docker",
    ...overrides,
  };
}

test("loadWorkerConfig applies documented defaults", () => {
  const config = loadWorkerConfig(baseEnv());

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 4180);
  assert.equal(config.requireRootless, true);
  assert.deepEqual(config.allowedImages, ["ezu/sandbox:frontend"]);
});

test("loadWorkerConfig rejects a short or missing WORKER_API_TOKEN", () => {
  assert.throws(() => loadWorkerConfig(baseEnv({ WORKER_API_TOKEN: "short" })), WorkerConfigError);
  assert.throws(() => loadWorkerConfig(baseEnv({ WORKER_API_TOKEN: undefined })), WorkerConfigError);
});

test("loadWorkerConfig requires an https preview base URL unless it is loopback", () => {
  assert.throws(
    () => loadWorkerConfig(baseEnv({ WORKER_PUBLIC_PREVIEW_BASE_URL: "http://preview.example.com" })),
    WorkerConfigError,
  );

  const devConfig = loadWorkerConfig(
    baseEnv({ WORKER_PUBLIC_PREVIEW_BASE_URL: "http://127.0.0.1:4180", WORKER_ALLOW_INSECURE_LOOPBACK: "true" }),
  );
  assert.equal(devConfig.publicPreviewBaseUrl, "http://127.0.0.1:4180");
});

test("loadWorkerConfig requires at least one allowed image", () => {
  assert.throws(() => loadWorkerConfig(baseEnv({ WORKER_ALLOWED_IMAGES: "" })), WorkerConfigError);
});

test("loadWorkerConfig lets WORKER_REQUIRE_ROOTLESS be disabled only explicitly", () => {
  const config = loadWorkerConfig(baseEnv({ WORKER_REQUIRE_ROOTLESS: "false" }));
  assert.equal(config.requireRootless, false);
});

test("loadWorkerConfig defaults the runtime create and docker operation timeouts", () => {
  const config = loadWorkerConfig(baseEnv());

  assert.equal(config.limits.runtimeCreateTimeoutMs, 60_000);
  assert.equal(config.limits.dockerOperationTimeoutMs, 30_000);
});

test("loadWorkerConfig rejects a non-positive WORKER_RUNTIME_CREATE_TIMEOUT_MS", () => {
  assert.throws(
    () => loadWorkerConfig(baseEnv({ WORKER_RUNTIME_CREATE_TIMEOUT_MS: "0" })),
    WorkerConfigError,
  );
});

test("loadWorkerConfig rejects a non-positive WORKER_DOCKER_OPERATION_TIMEOUT_MS", () => {
  assert.throws(
    () => loadWorkerConfig(baseEnv({ WORKER_DOCKER_OPERATION_TIMEOUT_MS: "not-a-number" })),
    WorkerConfigError,
  );
});
