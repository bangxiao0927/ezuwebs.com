import { createServer } from "node:http";

import { resolveBillingEnabled } from "./config/billing-config.js";
import { configureBillingEnabled, configureBillingStore } from "./domain/billing/billing-service.js";
import { createSqliteBillingStore } from "./domain/billing/sqlite-billing-store.js";
import {
  createFileSessionRepository,
  createMemorySessionRepository,
  importLegacyJsonSessionStore,
  type SessionRepository,
} from "./domain/session-repository.js";
import { configureSessionRepository, recoverSessionsOnStartup } from "./domain/sessions.js";
import { createSqliteSessionRepository } from "./domain/sqlite-session-repository.js";
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

const sessionRepository = await createConfiguredSessionRepository();
configureSessionRepository(sessionRepository);
configureBillingStore(createSqliteBillingStore());
configureBillingEnabled(resolveBillingEnabled(process.env));

const handler = createApiHandler();
const server = createServer((request, response) => {
  void handler(request, response);
});

recoverSessionsOnStartup()
  .catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error("[ezu/server] Failed to recover interrupted sessions on startup:", error);
  })
  .finally(() => {
    server.listen(port, host, () => {
      // eslint-disable-next-line no-console
      console.log(`[ezu/server] API listening on http://${host}:${port}`);
    });
  });
