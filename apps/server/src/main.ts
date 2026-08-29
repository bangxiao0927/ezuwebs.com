import { createServer } from "node:http";

import { createApiHandler } from "./http/router.js";
import { recoverSessionsOnStartup } from "./domain/sessions.js";

const port = Number.parseInt(process.env.PORT ?? "4175", 10);
const host = process.env.HOST ?? "127.0.0.1";

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
