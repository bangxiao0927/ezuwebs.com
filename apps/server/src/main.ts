import { createServer } from "node:http";

import { createRemoteRuntimeAdapter } from "@ezu/runtime-remote";

import { resolveBillingEnabled } from "./config/billing-config.js";
import { resolveRuntimeProviderConfig } from "./config/runtime-config.js";
import { configureBillingEnabled, configureBillingStore } from "./domain/billing/billing-service.js";
import { createSqliteBillingStore } from "./domain/billing/sqlite-billing-store.js";
import {
  createFileSessionRepository,
  createMemorySessionRepository,
  importLegacyJsonSessionStore,
  type SessionRepository,
} from "./domain/session-repository.js";
import {
  configureSessionRepository,
  configureSessionRuntimeManager,
  getSessionRuntimeManager,
  recoverSessionsOnStartup,
} from "./domain/sessions.js";
import { createSessionRuntimeManager } from "./domain/session-runtime-manager.js";
import { createSqliteSessionRepository } from "./domain/sqlite-session-repository.js";
import { createSqliteRunRepository } from "./domain/sqlite-run-repository.js";
import { configureRunRepository, recoverRunsOnStartup } from "./domain/run-service.js";
import { createMemoryRunRepository, type RunRepository } from "./domain/run-repository.js";
import { createApiHandler } from "./http/router.js";

const port = Number.parseInt(process.env.PORT ?? "4175", 10);
const host = process.env.HOST ?? "127.0.0.1";
const legacySessionStoreFile = process.env.SESSION_STORE_FILE ?? "./data/sessions.json";

async function createConfiguredSessionRepository(): Promise<SessionRepository> {
  const mode = process.env.SESSION_REPOSITORY ?? "sqlite";

  if (mode === "memory") {
    return createMemorySessionRepository();
  }
  if (mode === "json") {
    return createFileSessionRepository(legacySessionStoreFile);
  }

  const databaseUrl = process.env.DATABASE_URL;
  const repository = createSqliteSessionRepository(databaseUrl ? { databaseUrl } : {});
  try {
    const imported = await importLegacyJsonSessionStore(legacySessionStoreFile, repository);
    if (imported && (imported.importedCount > 0 || imported.skippedExistingCount > 0)) {
      // eslint-disable-next-line no-console
      console.log(
        `[ezu/server] Imported ${imported.importedCount} session(s) from the legacy JSON store ` +
          `(${imported.skippedExistingCount} already present in SQLite were left untouched).`,
      );
    }
  } catch (error) {
    // The legacy file is left in place on failure, so this is safe to retry on the next start.
    // eslint-disable-next-line no-console
    console.error(`[ezu/server] Failed to import the legacy JSON session store into SQLite:`, error);
  }
  return repository;
}

function createConfiguredRunRepository(): RunRepository {
  const mode = process.env.SESSION_REPOSITORY ?? "sqlite";
  if (mode === "memory" || mode === "json") {
    // The "json" legacy session store has no equivalent for runs; runs are a
    // new resource, so they fall back to an in-process memory repository.
    return createMemoryRunRepository();
  }
  const databaseUrl = process.env.DATABASE_URL;
  return createSqliteRunRepository(databaseUrl ? { databaseUrl } : {});
}

const sessionRepository = await createConfiguredSessionRepository();
configureSessionRepository(sessionRepository);
const billingEnabled = resolveBillingEnabled(process.env);
const runtimeProviderConfig = resolveRuntimeProviderConfig(process.env, { billingEnabled });
const configuredIdleTtlMs = Number.parseInt(process.env.SESSION_RUNTIME_IDLE_TTL_MS ?? "", 10);
configureSessionRuntimeManager(
  createSessionRuntimeManager(
    {
      ...(Number.isFinite(configuredIdleTtlMs) && configuredIdleTtlMs > 0 ? { idleTtlMs: configuredIdleTtlMs } : {}),
      ...(runtimeProviderConfig.provider === "remote"
        ? {
            createRuntime: (sessionId, seedFiles, projectId) =>
              createRemoteRuntimeAdapter(
                { ...runtimeProviderConfig.remote, sessionId, projectId: projectId ?? sessionId },
                seedFiles,
              ),
          }
        : {}),
    },
  ),
);
configureRunRepository(createConfiguredRunRepository());
configureBillingStore(createSqliteBillingStore());
configureBillingEnabled(billingEnabled);

const handler = createApiHandler();
const server = createServer((request, response) => {
  void handler(request, response);
});

const idleEvictionInterval = setInterval(() => {
  getSessionRuntimeManager().evictIdle();
}, 60_000);
idleEvictionInterval.unref();

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log(`[ezu/server] Received ${signal}, shutting down gracefully...`);
  clearInterval(idleEvictionInterval);
  server.close();
  await getSessionRuntimeManager().disposeAll();
  process.exit(0);
}

process.on("SIGTERM", (signal) => {
  void shutdown(signal);
});
process.on("SIGINT", (signal) => {
  void shutdown(signal);
});

recoverSessionsOnStartup()
  .then(() => recoverRunsOnStartup())
  .catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error("[ezu/server] Failed to recover interrupted sessions or runs on startup:", error);
  })
  .finally(() => {
    server.listen(port, host, () => {
      // eslint-disable-next-line no-console
      console.log(`[ezu/server] API listening on http://${host}:${port}`);
    });
  });
