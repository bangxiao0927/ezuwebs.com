import { createServer, type Server } from "node:http";
import path from "node:path";

import { CommandService } from "./commands/command-service.js";
import type { WorkerConfig } from "./config.js";
import type { DockerEngine } from "./docker/engine.js";
import { createRuntimeWorkerHandler } from "./http/router.js";
import { PreviewService } from "./preview/preview-service.js";
import { RuntimeRegistry } from "./registry/runtime-registry.js";
import { RuntimeService } from "./runtime-service.js";
import { RuntimeSweeper } from "./ttl/sweeper.js";
import { WorkspaceService } from "./workspace/workspace-service.js";

export interface RuntimeWorker {
  server: Server;
  runtimeService: RuntimeService;
  sweeper: RuntimeSweeper;
  shutdown: (options?: { disposeAllRuntimes?: boolean }) => Promise<void>;
}

const sweepIntervalMs = 60_000;

/**
 * Wires the registry, engine, and every domain service into a listening
 * HTTP server. Fails closed before ever listening: `requireRootless`
 * refuses to start against a docker daemon that does not confirm it is
 * rootless.
 */
export async function startRuntimeWorker(config: WorkerConfig, engine: DockerEngine): Promise<RuntimeWorker> {
  if (config.requireRootless) {
    await engine.assertRootless();
  }

  const registry = new RuntimeRegistry(path.join(config.root, "registry.json"), {
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
    ttlMs: config.limits.runtimeTtlMs,
  });
  const runtimeService = new RuntimeService(engine, registry, workspace, commands, preview, {
    allowedImages: config.allowedImages,
    memoryBytes: config.limits.memoryBytes,
    cpus: config.limits.cpus,
    pidsLimit: config.limits.pidsLimit,
    runtimeTtlMs: config.limits.runtimeTtlMs,
  });

  const sweeper = new RuntimeSweeper(runtimeService);
  await sweeper.reconcileStaleCreating();
  await sweeper.reconcileOrphans();

  const handler = createRuntimeWorkerHandler(config, runtimeService);
  const server = createServer((request, response) => {
    void handler(request, response);
  });

  const sweepTimer = setInterval(() => {
    void sweeper.sweepExpired();
  }, sweepIntervalMs);
  sweepTimer.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });

  let shuttingDown = false;
  const shutdown = async (options: { disposeAllRuntimes?: boolean } = {}): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    clearInterval(sweepTimer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtimeService.shutdown({ disposeAllRuntimes: options.disposeAllRuntimes ?? true });
  };

  return { server, runtimeService, sweeper, shutdown };
}
