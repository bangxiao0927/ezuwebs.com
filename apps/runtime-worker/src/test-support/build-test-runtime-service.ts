import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CommandService } from "../commands/command-service.js";
import { FakeDockerEngine } from "../docker/test-support/fake-docker-engine.js";
import { PreviewService } from "../preview/preview-service.js";
import { RuntimeRegistry } from "../registry/runtime-registry.js";
import { RuntimeService } from "../runtime-service.js";
import { WorkspaceService } from "../workspace/workspace-service.js";

export interface TestRuntimeServiceOptions {
  publicPreviewBaseUrl?: string;
  allowedImages?: string[];
  maxRuntimes?: number;
  runtimeTtlMs?: number;
}

export interface TestRuntimeServiceBundle {
  engine: FakeDockerEngine;
  registry: RuntimeRegistry;
  workspace: WorkspaceService;
  commands: CommandService;
  preview: PreviewService;
  runtimeService: RuntimeService;
}

/** Wires the same services `startRuntimeWorker` does, against `FakeDockerEngine`, for tests below the HTTP layer. */
export async function buildTestRuntimeService(
  options: TestRuntimeServiceOptions = {},
): Promise<TestRuntimeServiceBundle> {
  const dir = await mkdtemp(path.join(tmpdir(), "runtime-service-test-"));
  const engine = new FakeDockerEngine();
  const registry = new RuntimeRegistry(path.join(dir, "registry.json"), {
    maxRuntimes: options.maxRuntimes ?? 50,
  });
  await registry.load();
  const workspace = new WorkspaceService(engine, {
    maxFileBytes: 1024 * 1024,
    maxFileCount: 100,
    maxTotalBytes: 4 * 1024 * 1024,
  });
  const commands = new CommandService(engine, { maxTimeoutMs: 60_000, maxOutputBytes: 1024 * 1024 });
  const preview = new PreviewService({
    publicBaseUrl: options.publicPreviewBaseUrl ?? "http://127.0.0.1:4180",
    allowedPorts: [4173, 4174, 4175],
    ttlMs: 60_000,
  });
  const runtimeService = new RuntimeService(engine, registry, workspace, commands, preview, {
    allowedImages: options.allowedImages ?? ["ezu/sandbox:frontend"],
    memoryBytes: 512 * 1024 * 1024,
    cpus: 1,
    pidsLimit: 256,
    runtimeTtlMs: options.runtimeTtlMs ?? 60 * 60 * 1000,
  });

  return { engine, registry, workspace, commands, preview, runtimeService };
}
