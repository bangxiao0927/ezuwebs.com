import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { createApiHandler } from "./router.js";
import type { AuthServicePort } from "./auth-routes.js";
import type { AuthUser } from "../domain/auth/store.js";

function createFakeAuthService(overrides: Partial<AuthServicePort> = {}): AuthServicePort {
  return {
    sessionCookieName: "ezu_session",
    transactionCookieName: "ezu_oauth_txn",
    beginGoogleLogin: () => ({
      redirectUrl: "https://accounts.google.com/o/oauth2/v2/auth?fake=1",
      transactionCookie: "ezu_oauth_txn=fake-txn; Path=/; HttpOnly; SameSite=Lax",
    }),
    completeGoogleLogin: async () => ({
      user: { id: "user-1", email: "ada@example.com", plan: "free" } satisfies AuthUser,
      sessionCookie: "ezu_session=fake-session; Path=/; HttpOnly; SameSite=Lax",
      clearTransactionCookie: "ezu_oauth_txn=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    }),
    getCurrentUser: async (sessionCookieValue) =>
      sessionCookieValue === "fake-session"
        ? ({ id: "user-1", email: "ada@example.com", plan: "free" } satisfies AuthUser)
        : undefined,
    logout: async () => ({
      clearCookie: "ezu_session=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    }),
    ...overrides,
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

test("GET /api/auth/google redirects to Google and sets a transaction cookie", async () => {
  await withServer(createFakeAuthService(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/google`, { redirect: "manual" });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://accounts.google.com/o/oauth2/v2/auth?fake=1");
    assert.match(response.headers.get("set-cookie") ?? "", /ezu_oauth_txn=fake-txn/);
  });
});

test("GET /api/auth/google/callback sets a session cookie and redirects home on success", async () => {
  await withServer(createFakeAuthService(), async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/auth/google/callback?code=abc&state=xyz`,
      { redirect: "manual", headers: { cookie: "ezu_oauth_txn=stored-txn-value" } },
    );

    assert.equal(response.status, 302);
    assert.match(response.headers.get("set-cookie") ?? "", /ezu_session=fake-session/);
  });
});

test("GET /api/auth/google/callback redirects with an error indicator when the flow fails", async () => {
  await withServer(
    createFakeAuthService({
      completeGoogleLogin: async () => {
        throw new Error("state mismatch");
      },
    }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/auth/google/callback?code=abc&state=xyz`, {
        redirect: "manual",
      });

      assert.equal(response.status, 302);
      const location = response.headers.get("location") ?? "";
      assert.match(location, /authError=1/);
      assert.doesNotMatch(location, /state mismatch/);
    },
  );
});

test("GET /api/auth/me returns the current user for a valid session cookie", async () => {
  await withServer(createFakeAuthService(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { cookie: "ezu_session=fake-session" },
    });
    const body = (await response.json()) as { user: AuthUser | null };

    assert.equal(response.status, 200);
    assert.equal(body.user?.email, "ada@example.com");
  });
});

test("GET /api/auth/me returns a null user when there is no session", async () => {
  await withServer(createFakeAuthService(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/me`);
    const body = (await response.json()) as { user: AuthUser | null };

    assert.equal(response.status, 200);
    assert.equal(body.user, null);
  });
});

test("POST /api/auth/logout clears the session cookie", async () => {
  await withServer(createFakeAuthService(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { cookie: "ezu_session=fake-session" },
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie") ?? "", /Expires=Thu, 01 Jan 1970/);
  });
});
