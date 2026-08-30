import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTestWorker, testApiToken } from "../test-support/build-test-worker.js";

function authHeaders(token: string = testApiToken): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function createRuntime(baseUrl: string, sessionId = "session-1") {
  const response = await fetch(`${baseUrl}/internal/runtime/v1/runtimes`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      sessionId,
      projectId: "project-1",
      image: "ezu/sandbox:frontend",
      profile: "default",
    }),
  });
  return response;
}

test("a request without a valid bearer token is rejected with a generic 401", async () => {
  const worker = await buildTestWorker();
  try {
    const response = await fetch(`${worker.baseUrl}/internal/runtime/v1/runtimes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 401);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, "unauthorized");
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    await worker.close();
  }
});

test("creating a runtime twice for the same session is idempotent", async () => {
  const worker = await buildTestWorker();
  try {
    const first = await createRuntime(worker.baseUrl);
    const second = await createRuntime(worker.baseUrl);
    const firstBody = (await first.json()) as { runtimeId: string };
    const secondBody = (await second.json()) as { runtimeId: string };
    assert.equal(firstBody.runtimeId, secondBody.runtimeId);
  } finally {
    await worker.close();
  }
});

test("two different sessions get isolated runtimes", async () => {
  const worker = await buildTestWorker();
  try {
    const first = await createRuntime(worker.baseUrl, "session-a");
    const second = await createRuntime(worker.baseUrl, "session-b");
    const firstBody = (await first.json()) as { runtimeId: string };
    const secondBody = (await second.json()) as { runtimeId: string };
    assert.notEqual(firstBody.runtimeId, secondBody.runtimeId);
  } finally {
    await worker.close();
  }
});

test("an image outside the configured allowlist is rejected", async () => {
  const worker = await buildTestWorker();
  try {
    const response = await fetch(`${worker.baseUrl}/internal/runtime/v1/runtimes`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        sessionId: "s1",
        projectId: "p1",
        image: "not-allowed:latest",
        profile: "default",
      }),
    });
    assert.equal(response.status, 400);
  } finally {
    await worker.close();
  }
});

test("file write/read round-trips through the HTTP contract, and version conflicts are rejected", async () => {
  const worker = await buildTestWorker();
  try {
    const created = (await (await createRuntime(worker.baseUrl)).json()) as { runtimeId: string };
    const runtimeId = created.runtimeId;

    const writeResponse = await fetch(`${worker.baseUrl}/internal/runtime/v1/runtimes/${runtimeId}/files`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ path: "index.html", content: "<h1>hi</h1>" }),
    });
    assert.equal(writeResponse.status, 200);
    const written = (await writeResponse.json()) as { version: string };

    const readResponse = await fetch(
      `${worker.baseUrl}/internal/runtime/v1/runtimes/${runtimeId}/files?path=index.html`,
      { headers: authHeaders() },
    );
    const read = (await readResponse.json()) as { content: string; version: string };
    assert.equal(read.content, "<h1>hi</h1>");
    assert.equal(read.version, written.version);

    const conflictResponse = await fetch(`${worker.baseUrl}/internal/runtime/v1/runtimes/${runtimeId}/files`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ path: "index.html", content: "<h1>bye</h1>", expectedVersion: "stale" }),
    });
    assert.equal(conflictResponse.status, 409);
  } finally {
    await worker.close();
  }
});

test("a path escaping the workspace via '..' is rejected", async () => {
  const worker = await buildTestWorker();
  try {
    const created = (await (await createRuntime(worker.baseUrl)).json()) as { runtimeId: string };
    const response = await fetch(
      `${worker.baseUrl}/internal/runtime/v1/runtimes/${created.runtimeId}/files?path=../etc/passwd`,
      { headers: authHeaders() },
    );
    assert.equal(response.status, 400);
  } finally {
    await worker.close();
  }
});

test("a command outside its policy allowlist is rejected before running", async () => {
  const worker = await buildTestWorker();
  try {
    const created = (await (await createRuntime(worker.baseUrl)).json()) as { runtimeId: string };
    const response = await fetch(`${worker.baseUrl}/internal/runtime/v1/runtimes/${created.runtimeId}/commands`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        argv: ["bash", "-c", "evil"],
        timeoutMs: 1000,
        maxOutputBytes: 1024,
        policy: "frontend-build",
      }),
    });
    assert.equal(response.status, 400);
  } finally {
    await worker.close();
  }
});

test("a command's status, events, and cancel 404 when queried through a different runtime's id", async () => {
  const worker = await buildTestWorker();
  try {
    const runtimeA = (await (await createRuntime(worker.baseUrl, "session-a")).json()) as { runtimeId: string };
    const runtimeB = (await (await createRuntime(worker.baseUrl, "session-b")).json()) as { runtimeId: string };
    worker.engine.scriptedCommands.set("pnpm build", { exitCode: 0, stdout: "built\n" });

    const commandResponse = await fetch(
      `${worker.baseUrl}/internal/runtime/v1/runtimes/${runtimeA.runtimeId}/commands`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ argv: ["pnpm", "build"], timeoutMs: 5000, maxOutputBytes: 1024, policy: "frontend-build" }),
      },
    );
    const command = (await commandResponse.json()) as { commandId: string };

    const statusResponse = await fetch(
      `${worker.baseUrl}/internal/runtime/v1/runtimes/${runtimeB.runtimeId}/commands/${command.commandId}`,
      { headers: authHeaders() },
    );
    assert.equal(statusResponse.status, 404);

    const eventsResponse = await fetch(
      `${worker.baseUrl}/internal/runtime/v1/runtimes/${runtimeB.runtimeId}/commands/${command.commandId}/events`,
      { headers: authHeaders() },
    );
    assert.equal(eventsResponse.status, 404);

    const cancelResponse = await fetch(
      `${worker.baseUrl}/internal/runtime/v1/runtimes/${runtimeB.runtimeId}/commands/${command.commandId}/cancel`,
      { method: "POST", headers: authHeaders() },
    );
    assert.equal(cancelResponse.status, 404);
  } finally {
    await worker.close();
  }
});

const defaultTestLimits = {
  maxRuntimes: 50,
  memoryBytes: 512 * 1024 * 1024,
  cpus: 1,
  pidsLimit: 256,
  workspaceMaxFileBytes: 1024 * 1024,
  workspaceMaxFileCount: 100,
  workspaceMaxTotalBytes: 4 * 1024 * 1024,
  commandMaxOutputBytes: 1024 * 1024,
  commandMaxTimeoutMs: 60_000,
  runtimeTtlMs: 60 * 60 * 1000,
  runtimeCreateTimeoutMs: 60_000,
  dockerOperationTimeoutMs: 30_000,
};

test("a NaN or oversized timeoutMs is rejected or clamped rather than trusted as-is", async () => {
  const worker = await buildTestWorker({ limits: { ...defaultTestLimits, commandMaxTimeoutMs: 1000 } });
  try {
    const created = (await (await createRuntime(worker.baseUrl)).json()) as { runtimeId: string };

    const invalidResponse = await fetch(`${worker.baseUrl}/internal/runtime/v1/runtimes/${created.runtimeId}/commands`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ argv: ["node"], timeoutMs: Number.NaN, maxOutputBytes: 1024, policy: "frontend-build" }),
    });
    assert.equal(invalidResponse.status, 400);
  } finally {
    await worker.close();
  }
});

test("creating a runtime beyond the configured maxRuntimes is rejected with 429", async () => {
  const worker = await buildTestWorker({ limits: { ...defaultTestLimits, maxRuntimes: 1 } });
  try {
    const first = await createRuntime(worker.baseUrl, "session-a");
    assert.equal(first.status, 201);

    const second = await createRuntime(worker.baseUrl, "session-b");
    assert.equal(second.status, 429);
  } finally {
    await worker.close();
  }
});

test("an allowlisted command runs, and its events and status can be polled and cancelled idempotently", async () => {
  const worker = await buildTestWorker();
  try {
    const created = (await (await createRuntime(worker.baseUrl)).json()) as { runtimeId: string };
    worker.engine.scriptedCommands.set("pnpm build", { exitCode: 0, stdout: "built\n" });

    const commandResponse = await fetch(
      `${worker.baseUrl}/internal/runtime/v1/runtimes/${created.runtimeId}/commands`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ argv: ["pnpm", "build"], timeoutMs: 5000, maxOutputBytes: 1024, policy: "frontend-build" }),
      },
    );
    const command = (await commandResponse.json()) as { commandId: string };

    await new Promise((resolve) => setTimeout(resolve, 30));

    const eventsResponse = await fetch(
      `${worker.baseUrl}/internal/runtime/v1/runtimes/${created.runtimeId}/commands/${command.commandId}/events?afterSeq=0`,
      { headers: authHeaders() },
    );
    const events = (await eventsResponse.json()) as { events: { type: string }[] };
    assert.ok(events.events.some((event) => event.type === "exit"));

    const cancel1 = await fetch(
      `${worker.baseUrl}/internal/runtime/v1/runtimes/${created.runtimeId}/commands/${command.commandId}/cancel`,
      { method: "POST", headers: authHeaders() },
    );
    const cancel2 = await fetch(
      `${worker.baseUrl}/internal/runtime/v1/runtimes/${created.runtimeId}/commands/${command.commandId}/cancel`,
      { method: "POST", headers: authHeaders() },
    );
    assert.equal(cancel1.status, 200);
    assert.equal(cancel2.status, 200);
  } finally {
    await worker.close();
  }
});

test("previews only accept an allowlisted port and issue an opaque-token URL that serves the workspace over the public preview route", async () => {
  const worker = await buildTestWorker();
  try {
    const created = (await (await createRuntime(worker.baseUrl)).json()) as { runtimeId: string };
    await fetch(`${worker.baseUrl}/internal/runtime/v1/runtimes/${created.runtimeId}/files`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ path: "index.html", content: "<h1>preview</h1>" }),
    });

    const disallowed = await fetch(`${worker.baseUrl}/internal/runtime/v1/runtimes/${created.runtimeId}/previews`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ port: 9999 }),
    });
    assert.equal(disallowed.status, 400);

    const previewResponse = await fetch(
      `${worker.baseUrl}/internal/runtime/v1/runtimes/${created.runtimeId}/previews`,
      { method: "POST", headers: authHeaders(), body: JSON.stringify({ port: 4173 }) },
    );
    assert.equal(previewResponse.status, 201);
    const preview = (await previewResponse.json()) as { url: string };
    assert.match(preview.url, new RegExp(`^${worker.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/p/`));

    const pageResponse = await fetch(preview.url);
    assert.equal(pageResponse.status, 200);
    assert.equal(await pageResponse.text(), "<h1>preview</h1>");
    assert.equal(pageResponse.headers.get("x-content-type-options"), "nosniff");
    assert.ok(pageResponse.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"));
  } finally {
    await worker.close();
  }
});

test("deleting a runtime immediately 404s a previously issued preview token", async () => {
  const worker = await buildTestWorker();
  try {
    const created = (await (await createRuntime(worker.baseUrl)).json()) as { runtimeId: string };
    const previewResponse = await fetch(
      `${worker.baseUrl}/internal/runtime/v1/runtimes/${created.runtimeId}/previews`,
      { method: "POST", headers: authHeaders(), body: JSON.stringify({ port: 4173 }) },
    );
    const preview = (await previewResponse.json()) as { url: string };

    const deleteResponse = await fetch(`${worker.baseUrl}/internal/runtime/v1/runtimes/${created.runtimeId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    assert.equal(deleteResponse.status, 200);

    const pageResponse = await fetch(preview.url);
    assert.equal(pageResponse.status, 404);
  } finally {
    await worker.close();
  }
});

test("runtime-wide events surface file and preview changes and support afterSeq polling", async () => {
  const worker = await buildTestWorker();
  try {
    const created = (await (await createRuntime(worker.baseUrl)).json()) as { runtimeId: string };
    await fetch(`${worker.baseUrl}/internal/runtime/v1/runtimes/${created.runtimeId}/files`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ path: "a.txt", content: "1" }),
    });
    await fetch(`${worker.baseUrl}/internal/runtime/v1/runtimes/${created.runtimeId}/previews`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ port: 4173 }),
    });

    const eventsResponse = await fetch(
      `${worker.baseUrl}/internal/runtime/v1/runtimes/${created.runtimeId}/events?afterSeq=0`,
      { headers: authHeaders() },
    );
    const events = (await eventsResponse.json()) as { events: { type: string }[]; nextSeq: number };
    assert.equal(events.events.length, 2);
    assert.equal(events.events[0]?.type, "file.changed");
    assert.equal(events.events[1]?.type, "port.changed");
  } finally {
    await worker.close();
  }
});
