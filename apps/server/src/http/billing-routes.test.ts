import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { createApiHandler } from "./router.js";
import type { AuthServicePort } from "./auth-routes.js";
import type { AuthUser } from "../domain/auth/store.js";
import { configureBillingStore, FREE_GRANT_CREDITS } from "../domain/billing/billing-service.js";
import { createMemoryBillingStore } from "../domain/billing/memory-billing-store.js";

const USER_A: AuthUser = { id: "user-a", email: "a@example.com", plan: "free" };
const USER_B: AuthUser = { id: "user-b", email: "b@example.com", plan: "free" };

function createFakeAuthService(currentUser: AuthUser | undefined): AuthServicePort {
  return {
    sessionCookieName: "ezu_session",
    transactionCookieName: "ezu_oauth_txn",
    beginGoogleLogin: () => {
      throw new Error("not used in this test");
    },
    completeGoogleLogin: async () => {
      throw new Error("not used in this test");
    },
    getCurrentUser: async (sessionCookieValue) =>
      sessionCookieValue === "valid-session" ? currentUser : undefined,
    logout: async () => ({ clearCookie: "ezu_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT" }),
  };
}

async function withServer(
  authService: AuthServicePort,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const handler = createApiHandler({ authService });
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

function resetBilling(): void {
  configureBillingStore(createMemoryBillingStore());
  delete process.env["BILLING_DEV_GRANTS"];
}

test("GET /api/billing/summary requires authentication", async () => {
  resetBilling();
  await withServer(createFakeAuthService(USER_A), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/billing/summary`);
    assert.equal(response.status, 401);
  });
});

test("GET /api/billing/summary returns the signed-in user's own balance", async () => {
  resetBilling();
  await withServer(createFakeAuthService(USER_A), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/billing/summary`, {
      headers: { cookie: "ezu_session=valid-session" },
    });
    const body = (await response.json()) as { balance: number };

    assert.equal(response.status, 200);
    assert.equal(body.balance, FREE_GRANT_CREDITS);
  });
});

test("POST /api/billing/dev-grant is disabled (404) unless BILLING_DEV_GRANTS=true", async () => {
  resetBilling();
  await withServer(createFakeAuthService(USER_A), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/billing/dev-grant`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
      body: JSON.stringify({ packageId: "dev-small" }),
    });
    assert.equal(response.status, 404);
  });
});

test("POST /api/billing/dev-grant rejects a package id the frontend did not tamper honestly", async () => {
  resetBilling();
  process.env["BILLING_DEV_GRANTS"] = "true";
  await withServer(createFakeAuthService(USER_A), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/billing/dev-grant`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
      body: JSON.stringify({ packageId: "unlimited-credits" }),
    });
    assert.equal(response.status, 400);
  });
});

test("POST /api/billing/dev-grant grants the server-defined amount for a valid package id", async () => {
  resetBilling();
  process.env["BILLING_DEV_GRANTS"] = "true";
  await withServer(createFakeAuthService(USER_A), async (baseUrl) => {
    const summary = await fetch(`${baseUrl}/api/billing/summary`, {
      headers: { cookie: "ezu_session=valid-session" },
    });
    const { balance: before, devGrantPackages } = (await summary.json()) as {
      balance: number;
      devGrantPackages: Array<{ id: string; credits: number }>;
    };

    const response = await fetch(`${baseUrl}/api/billing/dev-grant`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
      body: JSON.stringify({ packageId: devGrantPackages[0]!.id }),
    });
    const body = (await response.json()) as { balance: number };

    assert.equal(response.status, 200);
    assert.equal(body.balance, before + devGrantPackages[0]!.credits);
  });
});

test("GET /api/billing/summary isolates balances between users", async () => {
  resetBilling();
  process.env["BILLING_DEV_GRANTS"] = "true";
  await withServer(createFakeAuthService(USER_A), async (baseUrl) => {
    await fetch(`${baseUrl}/api/billing/dev-grant`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
      body: JSON.stringify({ packageId: "dev-small" }),
    });
  });

  await withServer(createFakeAuthService(USER_B), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/billing/summary`, {
      headers: { cookie: "ezu_session=valid-session" },
    });
    const body = (await response.json()) as { balance: number };
    assert.equal(body.balance, FREE_GRANT_CREDITS);
  });
});

test("GET /api/billing/usage respects limit and offset boundaries", async () => {
  resetBilling();
  process.env["BILLING_DEV_GRANTS"] = "true";
  await withServer(createFakeAuthService(USER_A), async (baseUrl) => {
    for (let i = 0; i < 3; i += 1) {
      await fetch(`${baseUrl}/api/billing/dev-grant`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
        body: JSON.stringify({ packageId: "dev-small" }),
      });
    }

    const response = await fetch(`${baseUrl}/api/billing/usage?limit=0&offset=-1`, {
      headers: { cookie: "ezu_session=valid-session" },
    });
    const body = (await response.json()) as { limit: number; offset: number };

    assert.equal(response.status, 200);
    assert.equal(body.limit, 1);
    assert.equal(body.offset, 0);
  });
});

test("GET /api/billing/usage requires authentication", async () => {
  resetBilling();
  await withServer(createFakeAuthService(USER_A), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/billing/usage`);
    assert.equal(response.status, 401);
  });
});
