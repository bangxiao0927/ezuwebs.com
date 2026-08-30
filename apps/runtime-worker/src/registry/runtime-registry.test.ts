import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { RuntimeCapacityError, RuntimeRegistry } from "./runtime-registry.js";

async function newRegistryFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "runtime-registry-"));
  return path.join(dir, "registry.json");
}

test("create() persists a new runtime record with status creating", async () => {
  const filePath = await newRegistryFile();
  const registry = new RuntimeRegistry(filePath);
  await registry.load();

  const record = await registry.create({ sessionId: "s1", projectId: "p1", image: "img", profile: "default" });

  assert.equal(record.status, "creating");
  assert.equal(record.sessionId, "s1");

  const persisted = JSON.parse(await readFile(filePath, "utf8")) as { runtimes: unknown[] };
  assert.equal(persisted.runtimes.length, 1);
});

test("create() is idempotent per session: a second call returns the same active runtime", async () => {
  const filePath = await newRegistryFile();
  const registry = new RuntimeRegistry(filePath);
  await registry.load();

  const first = await registry.create({ sessionId: "s1", projectId: "p1", image: "img", profile: "default" });
  const second = await registry.create({ sessionId: "s1", projectId: "p1", image: "img", profile: "default" });

  assert.equal(second.runtimeId, first.runtimeId);
});

test("create() allocates a fresh runtime once the previous one for that session is stopped", async () => {
  const filePath = await newRegistryFile();
  const registry = new RuntimeRegistry(filePath);
  await registry.load();

  const first = await registry.create({ sessionId: "s1", projectId: "p1", image: "img", profile: "default" });
  await registry.setStatus(first.runtimeId, "stopped");

  const second = await registry.create({ sessionId: "s1", projectId: "p1", image: "img", profile: "default" });
  assert.notEqual(second.runtimeId, first.runtimeId);
});

test("a reloaded registry sees records written by a previous instance", async () => {
  const filePath = await newRegistryFile();
  const registry = new RuntimeRegistry(filePath);
  await registry.load();
  const record = await registry.create({ sessionId: "s1", projectId: "p1", image: "img", profile: "default" });

  const reloaded = new RuntimeRegistry(filePath);
  await reloaded.load();
  const found = reloaded.get(record.runtimeId);
  assert.ok(found);
  assert.equal(found?.sessionId, "s1");
});

test("create() rejects once the number of active runtimes reaches the configured maximum", async () => {
  const filePath = await newRegistryFile();
  const registry = new RuntimeRegistry(filePath, { maxRuntimes: 1 });
  await registry.load();

  await registry.create({ sessionId: "s1", projectId: "p1", image: "img", profile: "default" });

  await assert.rejects(
    () => registry.create({ sessionId: "s2", projectId: "p1", image: "img", profile: "default" }),
    RuntimeCapacityError,
  );
});

test("create() stays idempotent for an already-active session even at capacity", async () => {
  const filePath = await newRegistryFile();
  const registry = new RuntimeRegistry(filePath, { maxRuntimes: 1 });
  await registry.load();

  const first = await registry.create({ sessionId: "s1", projectId: "p1", image: "img", profile: "default" });
  const second = await registry.create({ sessionId: "s1", projectId: "p1", image: "img", profile: "default" });

  assert.equal(second.runtimeId, first.runtimeId);
});

test("create() allows a new runtime again once a failed one frees capacity", async () => {
  const filePath = await newRegistryFile();
  const registry = new RuntimeRegistry(filePath, { maxRuntimes: 1 });
  await registry.load();

  const first = await registry.create({ sessionId: "s1", projectId: "p1", image: "img", profile: "default" });
  await registry.setStatus(first.runtimeId, "failed");

  const second = await registry.create({ sessionId: "s2", projectId: "p1", image: "img", profile: "default" });
  assert.notEqual(second.runtimeId, first.runtimeId);
});
