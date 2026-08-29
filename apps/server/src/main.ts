import { createServer } from "node:http";

import { resolveBillingEnabled } from "./config/billing-config.js";
import { configureBillingEnabled, configureBillingStore } from "./domain/billing/billing-service.js";
import { createSqliteBillingStore } from "./domain/billing/sqlite-billing-store.js";
import { createFileSessionRepository } from "./domain/session-repository.js";
import { configureSessionRepository, recoverSessionsOnStartup } from "./domain/sessions.js";
import { createApiHandler } from "./http/router.js";

const port = Number.parseInt(process.env.PORT ?? "4175", 10);
const host = process.env.HOST ?? "127.0.0.1";

const sessionRepository = await createFileSessionRepository(
  process.env.SESSION_STORE_FILE ?? "./data/sessions.json",
);
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
