import { mkdir } from "node:fs/promises";
import path from "node:path";

import { loadWorkerConfig } from "./config.js";
import { DockerCliEngine } from "./docker/docker-cli-engine.js";
import { startRuntimeWorker } from "./server.js";

const config = loadWorkerConfig(process.env);
await mkdir(config.root, { recursive: true });
const scratchRoot = path.join(config.root, "scratch");
await mkdir(scratchRoot, { recursive: true, mode: 0o700 });

const engine = new DockerCliEngine({ dockerBin: config.dockerBin, scratchRoot });

const worker = await startRuntimeWorker(config, engine);
// eslint-disable-next-line no-console
console.log(`[runtime-worker] listening on http://${config.host}:${config.port}`);

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log(`[runtime-worker] received ${signal}, shutting down`);
  await worker.shutdown({ disposeAllRuntimes: true });
  process.exit(0);
}

process.on("SIGTERM", (signal) => {
  void shutdown(signal);
});
process.on("SIGINT", (signal) => {
  void shutdown(signal);
});
