import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { createApiHandler } from "./router.js";
import { configureBillingEnabled } from "../domain/billing/billing-service.js";
import { configureSessionRepository } from "../domain/sessions.js";
import { createMemorySessionRepository } from "../domain/session-repository.js";

/**
 * No authService is supplied here on purpose: the router falls back to
 * resolveDefaultAuthService(), which throws in this test environment
 * because GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI are unset. This is exactly
 * the "Google auth not configured" production scenario billing_enabled=false
 * must tolerate without turning into a 500.
 */
async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const handler = createApiHandler();
  const server: Server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("POST /api/sessions/:id/prompt runs anonymously without a 500 when billing is disabled and the auth service cannot be constructed", async () => {
  configureSessionRepository(createMemorySessionRepository());
  configureBillingEnabled(false);

  await withServer(async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "club-promo" }),
    });
    const { session } = (await created.json()) as { session: { id: string } };

    const response = await fetch(`${baseUrl}/api/sessions/${session.id}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Make the hero more concise" }),
    });

    assert.equal(response.status, 200);
  });

  configureBillingEnabled(true);
});
