import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CommandService } from "../commands/command-service.js";
import { type WorkerConfig } from "../config.js";
import { FakeDockerEngine } from "../docker/test-support/fake-docker-engine.js";
import { createRuntimeWorkerHandler } from "../http/router.js";
import { PreviewService } from "../preview/preview-service.js";
import { RuntimeRegistry } from "../registry/runtime-registry.js";
import { RuntimeService } from "../runtime-service.js";
import { WorkspaceService } from "../workspace/workspace-service.js";

export const testApiToken = "test-token-".padEnd(32, "x");

export interface TestWorker {
  server: Server;
  baseUrl: string;
  engine: FakeDockerEngine;
  registry: RuntimeRegistry;
  runtimeService: RuntimeService;
  config: WorkerConfig;
  close: () => Promise<void>;
}

export async function buildTestWorker(overrides: Partial<WorkerConfig> = {}): Promise<TestWorker> {
  const dir = await mkdtemp(path.join(tmpdir(), "runtime-worker-test-"));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  const config: WorkerConfig = {
    host: "127.0.0.1",
    port,
    apiToken: testApiToken,
    root: dir,
    publicPreviewBaseUrl: baseUrl,
    allowInsecureLoopback: true,
    allowedImages: ["ezu/sandbox:frontend"],
    dockerBin: "/usr/bin/docker",
    requireRootless: true,
    limits: {
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
    },
    ...overrides,
  };

  const engine = new FakeDockerEngine();
  const registry = new RuntimeRegistry(path.join(dir, "registry.json"), {
    maxRuntimes: config.limits.maxRuntimes,
    createTimeoutMs: config.limits.runtimeCreateTimeoutMs,
  });
  await registry.load();
  const workspace = new WorkspaceService(engine, {
    maxFileBytes: config.limits.workspaceMaxFileBytes,
    maxFileCount: config.limits.workspaceMaxFileCount,
    maxTotalBytes: config.limits.workspaceMaxTotalBytes,
  });
  const commands = new CommandService(engine, {
    maxTimeoutMs: config.limits.commandMaxTimeoutMs,
    maxOutputBytes: config.limits.commandMaxOutputBytes,
  });
  const preview = new PreviewService({
    publicBaseUrl: config.publicPreviewBaseUrl,
    allowedPorts: [4173, 4174, 4175],
    ttlMs: 60_000,
  });
  const runtimeService = new RuntimeService(engine, registry, workspace, commands, preview, {
    allowedImages: config.allowedImages,
    memoryBytes: config.limits.memoryBytes,
    cpus: config.limits.cpus,
    pidsLimit: config.limits.pidsLimit,
    runtimeTtlMs: config.limits.runtimeTtlMs,
  });

  const handler = createRuntimeWorkerHandler(config, runtimeService);
  server.on("request", (request, response) => {
    void handler(request, response);
  });

  return {
    server,
    baseUrl,
    engine,
    registry,
    runtimeService,
    config,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
