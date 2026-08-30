import assert from "node:assert/strict";
import test from "node:test";

import { validateRemoteRuntimeConfig } from "./config.js";
import {
  RemoteRuntimeConnectTimeoutError,
  RemoteRuntimeHttpError,
  RemoteRuntimeRedirectError,
  RemoteRuntimeReadTimeoutError,
  RemoteRuntimeResponseTooLargeError,
} from "./errors.js";
import { requestRuntimeWorker } from "./http-client.js";
import { startFakeWorkerServer } from "./test-support/fake-worker-server.js";

function configFor(baseUrl: string) {
  return validateRemoteRuntimeConfig({
    baseUrl,
    apiToken: "secret-token",
    sessionId: "session-a",
    projectId: "project-a",
    image: "node20",
    profile: "default",
    allowInsecureLoopback: true,
    connectTimeoutMs: 200,
    readTimeoutMs: 200,
  });
}

test("requestRuntimeWorker sends a bearer token and JSON headers, and parses the JSON response", async () => {
  const worker = await startFakeWorkerServer();
  try {
    const config = configFor(worker.url);
    const result = await requestRuntimeWorker(config, "/internal/runtime/v1/runtimes", {
      method: "POST",
      body: { sessionId: "session-a", projectId: "project-a" },
    });

    assert.deepEqual(result, { runtimeId: "runtime-1", sessionId: "session-a", status: "ready" });
    const recorded = worker.requests[0]!;
    assert.equal(recorded.headers.authorization, "Bearer secret-token");
    assert.equal(recorded.headers["content-type"], "application/json");
    assert.deepEqual(recorded.body, { sessionId: "session-a", projectId: "project-a" });
  } finally {
    await worker.close();
  }
});

test("requestRuntimeWorker maps a non-2xx response to a typed error without leaking the auth token", async () => {
  const worker = await startFakeWorkerServer({
    failOn: () => ({ status: 500, body: "internal worker failure" }),
  });
  try {
    const config = configFor(worker.url);
    await assert.rejects(
      requestRuntimeWorker(config, "/internal/runtime/v1/runtimes", { method: "POST", body: {} }),
      (error: unknown) => {
        assert.ok(error instanceof RemoteRuntimeHttpError);
        assert.equal(error.status, 500);
        assert.ok(!error.message.includes("internal worker failure"), "the worker's response body must not leak into the error message");
        assert.ok(!error.message.includes("secret-token"));
        return true;
      },
    );
  } finally {
    await worker.close();
  }
});

test("requestRuntimeWorker throws a typed error for a redirect response and does not follow it", async () => {
  const worker = await startFakeWorkerServer({
    redirectOnPath: () => ({ status: 302, location: "https://attacker.example.test/steal" }),
  });
  try {
    const config = configFor(worker.url);
    await assert.rejects(
      requestRuntimeWorker(config, "/internal/runtime/v1/runtimes", { method: "POST", body: {} }),
      (error: unknown) => {
        assert.ok(error instanceof RemoteRuntimeRedirectError);
        assert.equal(error.status, 302);
        return true;
      },
    );
    assert.equal(
      worker.requests.filter((request) => request.path.includes("attacker")).length,
      0,
      "the redirect target must never be requested",
    );
  } finally {
    await worker.close();
  }
});

test("requestRuntimeWorker aborts the in-flight request when the caller's AbortSignal fires", async () => {
  const worker = await startFakeWorkerServer({
    responseDelayMs: 200,
  });
  try {
    const config = configFor(worker.url);
    const controller = new AbortController();
    const requestPromise = requestRuntimeWorker(
      config,
      "/internal/runtime/v1/runtimes",
      { method: "POST", body: {}, signal: controller.signal },
    );
    controller.abort();
    await assert.rejects(requestPromise, (error: unknown) => error instanceof Error);
  } finally {
    await worker.close();
  }
});

test("requestRuntimeWorker throws a typed error when the worker response exceeds the size limit", async () => {
  const worker = await startFakeWorkerServer({
    oversizedBodyOnPath: () => 1024,
  });
  try {
    const config = validateRemoteRuntimeConfig({
      baseUrl: worker.url,
      apiToken: "secret-token",
      sessionId: "session-a",
      projectId: "project-a",
      image: "node20",
      profile: "default",
      allowInsecureLoopback: true,
      limits: { maxResponseBytes: 100 },
    });
    await assert.rejects(
      requestRuntimeWorker(config, "/internal/runtime/v1/runtimes", { method: "POST", body: {} }),
      RemoteRuntimeResponseTooLargeError,
    );
  } finally {
    await worker.close();
  }
});

test("requestRuntimeWorker throws when the worker connection is refused", async () => {
  const config = validateRemoteRuntimeConfig({
    baseUrl: "http://127.0.0.1:1",
    apiToken: "secret-token",
    sessionId: "session-a",
    projectId: "project-a",
    image: "node20",
    profile: "default",
    allowInsecureLoopback: true,
    connectTimeoutMs: 100,
  });
  await assert.rejects(
    requestRuntimeWorker(config, "/internal/runtime/v1/runtimes", { method: "POST", body: {} }),
    (error: unknown) => error instanceof Error,
  );
});

test("requestRuntimeWorker throws a connect-timeout error when the worker never sends headers", async () => {
  const worker = await startFakeWorkerServer({
    hangOnPath: () => true,
  });
  try {
    const config = configFor(worker.url);
    await assert.rejects(
      requestRuntimeWorker(config, "/internal/runtime/v1/runtimes", { method: "POST", body: {} }),
      RemoteRuntimeConnectTimeoutError,
    );
  } finally {
    await worker.close();
  }
});

test("requestRuntimeWorker throws a read-timeout error when headers arrive but the body never finishes", async () => {
  const worker = await startFakeWorkerServer({
    hangAfterHeadersOnPath: () => true,
  });
  try {
    const config = configFor(worker.url);
    await assert.rejects(
      requestRuntimeWorker(
        { ...config, connectTimeoutMs: 5_000 },
        "/internal/runtime/v1/runtimes",
        { method: "POST", body: {} },
      ),
      RemoteRuntimeReadTimeoutError,
    );
  } finally {
    await worker.close();
  }
});
