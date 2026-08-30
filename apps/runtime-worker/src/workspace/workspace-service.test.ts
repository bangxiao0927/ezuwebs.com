import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeDockerEngine } from "../docker/test-support/fake-docker-engine.js";
import { WorkspaceConflictError, WorkspaceQuotaError, WorkspaceService } from "./workspace-service.js";

async function newContainer(engine: FakeDockerEngine): Promise<string> {
  const { containerId } = await engine.createContainer({
    runtimeId: "rt1",
    image: "img",
    labels: {},
    memoryBytes: 1,
    cpus: 1,
    pidsLimit: 1,
    workspaceExec: false,
  });
  return containerId;
}

function newService(overrides: Partial<{ maxFileBytes: number; maxFileCount: number; maxTotalBytes: number }> = {}) {
  const engine = new FakeDockerEngine();
  const service = new WorkspaceService(engine, {
    maxFileBytes: 1024,
    maxFileCount: 10,
    maxTotalBytes: 4096,
    ...overrides,
  });
  return { engine, service };
}

test("writeFile then readFile round-trips content and reports a stable version", async () => {
  const { engine, service } = newService();
  const containerId = await newContainer(engine);

  const written = await service.writeFile(containerId, "a.txt", "hello");
  const read = await service.readFile(containerId, "a.txt");

  assert.equal(read.content, "hello");
  assert.equal(read.version, written.version);
});

test("writeFile with a stale expectedVersion is rejected as a conflict", async () => {
  const { engine, service } = newService();
  const containerId = await newContainer(engine);
  await service.writeFile(containerId, "a.txt", "v1");

  await assert.rejects(
    () => service.writeFile(containerId, "a.txt", "v2", { expectedVersion: "not-the-real-version" }),
    WorkspaceConflictError,
  );
});

test("writeFile succeeds when expectedVersion matches the current version", async () => {
  const { engine, service } = newService();
  const containerId = await newContainer(engine);
  const first = await service.writeFile(containerId, "a.txt", "v1");

  await assert.doesNotReject(() =>
    service.writeFile(containerId, "a.txt", "v2", { expectedVersion: first.version }),
  );
});

test("writeFile rejects content larger than maxFileBytes", async () => {
  const { engine, service } = newService({ maxFileBytes: 4 });
  const containerId = await newContainer(engine);

  await assert.rejects(() => service.writeFile(containerId, "a.txt", "too long"), WorkspaceQuotaError);
});

test("writeFile rejects once maxFileCount distinct files would be exceeded", async () => {
  const { engine, service } = newService({ maxFileCount: 1 });
  const containerId = await newContainer(engine);
  await service.writeFile(containerId, "a.txt", "1");

  await assert.rejects(() => service.writeFile(containerId, "b.txt", "2"), WorkspaceQuotaError);
});

test("writeFile rejects once maxTotalBytes across all files would be exceeded", async () => {
  const { engine, service } = newService({ maxTotalBytes: 6 });
  const containerId = await newContainer(engine);
  await service.writeFile(containerId, "a.txt", "123");

  await assert.rejects(() => service.writeFile(containerId, "b.txt", "1234"), WorkspaceQuotaError);
});

test("patchFile appends to existing content, matching the seeded-content convention", async () => {
  const { engine, service } = newService();
  const containerId = await newContainer(engine);
  await service.writeFile(containerId, "a.txt", "const seeded = true;");

  await service.patchFile(containerId, "a.txt", "// appended patch");

  const read = await service.readFile(containerId, "a.txt");
  assert.equal(read.content, "const seeded = true;\n// appended patch");
});

test("deleteFile removes the file so a later read reports not found", async () => {
  const { engine, service } = newService();
  const containerId = await newContainer(engine);
  await service.writeFile(containerId, "a.txt", "content");

  await service.deleteFile(containerId, "a.txt");

  await assert.rejects(() => service.readFile(containerId, "a.txt"));
});

test("listFiles paginates and rejects a path that escapes the workspace via '..'", async () => {
  const { engine, service } = newService();
  const containerId = await newContainer(engine);
  await service.writeFile(containerId, "a.txt", "1");
  await service.writeFile(containerId, "b.txt", "2");
  await service.writeFile(containerId, "c.txt", "3");

  const page1 = await service.listFiles(containerId, "", { limit: 2 });
  assert.equal(page1.files.length, 2);
  assert.ok(page1.nextCursor);

  const page2 = await service.listFiles(containerId, "", { limit: 2, cursor: page1.nextCursor });
  assert.equal(page2.files.length, 1);
  assert.equal(page2.nextCursor, undefined);

  await assert.rejects(() => service.readFile(containerId, "../outside.txt"));
});
