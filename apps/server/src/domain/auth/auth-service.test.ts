import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { AuthFlowError, AuthService } from "./auth-service.js";
import { hashSessionToken } from "./token-hash.js";
import type { AuthStore, AuthUser, GoogleIdentity } from "./store.js";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = "test-key-1";
const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string; kty: string };

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signIdToken(claims: Record<string, unknown>): string {
  const header = { alg: "RS256", kid, typ: "JWT" };
  const headerSegment = base64UrlEncode(JSON.stringify(header));
  const payloadSegment = base64UrlEncode(JSON.stringify(claims));
  const signedData = `${headerSegment}.${payloadSegment}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signedData), privateKey);
  return `${signedData}.${base64UrlEncode(signature)}`;
}

function createFakeStore(): AuthStore & { users: AuthUser[]; sessions: Map<string, { userId: string; expiresAt: Date; revoked: boolean }> } {
  const users: AuthUser[] = [];
  const sessions = new Map<string, { userId: string; expiresAt: Date; revoked: boolean }>();
  return {
    users,
    sessions,
    async findOrCreateGoogleUser(identity: GoogleIdentity) {
      const existing = users.find((candidate) => candidate.email === identity.email);
      if (existing) {
        return existing;
      }
      const created: AuthUser = {
        id: `user-${users.length + 1}`,
        email: identity.email,
        plan: "free",
        ...(identity.name ? { name: identity.name } : {}),
      };
      users.push(created);
      return created;
    },
    async createAuthSession(input) {
      sessions.set(input.tokenHash, { userId: input.userId, expiresAt: input.expiresAt, revoked: false });
    },
    async findUserByActiveSession(tokenHash) {
      const session = sessions.get(tokenHash);
      if (!session || session.revoked || session.expiresAt.getTime() <= Date.now()) {
        return undefined;
      }
      return users.find((user) => user.id === session.userId);
    },
    async revokeAuthSession(tokenHash) {
      const session = sessions.get(tokenHash);
      if (session) session.revoked = true;
    },
  };
}

function createService(overrides: { fetchImpl?: typeof fetch; now?: () => Date } = {}) {
  const store = createFakeStore();
  const service = new AuthService(
    {
      google: {
        clientId: "test-client-id",
        clientSecret: "test-secret",
        redirectUri: "https://app.example.com/api/auth/google/callback",
      },
    },
    {
      store,
      fetchImpl:
        overrides.fetchImpl ??
        (async () => {
          throw new Error("fetchImpl not configured for this test");
        }),
      fetchJwks: async () => ({ keys: [{ kty: jwk.kty, kid, n: jwk.n, e: jwk.e }] }),
      now: overrides.now ?? (() => new Date("2024-01-01T00:00:00Z")),
      randomToken: (() => {
        let counter = 0;
        return (byteLength?: number) => `random-token-${counter++}-${byteLength ?? ""}`;
      })(),
    },
  );
  return { service, store };
}

test("beginGoogleLogin returns a Google authorization redirect and a transaction cookie", () => {
  const { service } = createService();

  const result = service.beginGoogleLogin();

  assert.match(result.redirectUrl, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.match(result.transactionCookie, /HttpOnly/);
  assert.match(result.transactionCookie, /SameSite=Lax/);
});

test("completeGoogleLogin exchanges the code, verifies the ID token, and issues a session cookie", async () => {
  const beginResult = { state: "", nonce: "", codeVerifier: "" };
  const { service, store } = createService({
    fetchImpl: async () => {
      const idToken = signIdToken({
        iss: "https://accounts.google.com",
        aud: "test-client-id",
        sub: "google-subject-1",
        email: "ada@example.com",
        email_verified: true,
        nonce: beginResult.nonce,
        exp: Math.floor(Date.now() / 1000) + 3600,
        name: "Ada Lovelace",
      });
      return new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
    },
  });

  const begun = service.beginGoogleLogin();
  const cookieValueMatch = /ezu_oauth_txn=([^;]+)/.exec(begun.transactionCookie);
  assert.ok(cookieValueMatch);
  const txn = JSON.parse(decodeURIComponent(cookieValueMatch[1]!)) as {
    state: string;
    nonce: string;
    codeVerifier: string;
  };
  beginResult.state = txn.state;
  beginResult.nonce = txn.nonce;
  beginResult.codeVerifier = txn.codeVerifier;

  const result = await service.completeGoogleLogin({
    code: "auth-code",
    state: txn.state,
    transactionCookieValue: decodeURIComponent(cookieValueMatch[1]!),
  });

  assert.equal(result.user.email, "ada@example.com");
  assert.match(result.sessionCookie, /HttpOnly/);
  assert.equal(store.users.length, 1);
  assert.equal(store.sessions.size, 1);
});

test("completeGoogleLogin rejects a state that does not match the transaction cookie", async () => {
  const { service } = createService();
  const begun = service.beginGoogleLogin();
  const cookieValueMatch = /ezu_oauth_txn=([^;]+)/.exec(begun.transactionCookie);
  assert.ok(cookieValueMatch);

  await assert.rejects(
    service.completeGoogleLogin({
      code: "auth-code",
      state: "not-the-real-state",
      transactionCookieValue: decodeURIComponent(cookieValueMatch[1]!),
    }),
    AuthFlowError,
  );
});

test("completeGoogleLogin rejects when the transaction cookie is missing", async () => {
  const { service } = createService();

  await assert.rejects(
    service.completeGoogleLogin({ code: "auth-code", state: "some-state", transactionCookieValue: undefined }),
    AuthFlowError,
  );
});

test("getCurrentUser resolves the user for an active session cookie and undefined otherwise", async () => {
  const { service, store } = createService();
  const sessionToken = "raw-session-token";
  await store.createAuthSession({
    userId: "user-1",
    tokenHash: hashSessionToken(sessionToken),
    expiresAt: new Date(Date.now() + 60_000),
  });
  store.users.push({ id: "user-1", email: "known@example.com", plan: "free" });

  assert.equal((await service.getCurrentUser(sessionToken))?.email, "known@example.com");
  assert.equal(await service.getCurrentUser("unknown-token"), undefined);
  assert.equal(await service.getCurrentUser(undefined), undefined);
});

test("logout revokes the session and returns a cookie-clearing header", async () => {
  const { service, store } = createService();
  const sessionToken = "raw-session-token";
  await store.createAuthSession({
    userId: "user-1",
    tokenHash: hashSessionToken(sessionToken),
    expiresAt: new Date(Date.now() + 60_000),
  });

  const result = await service.logout(sessionToken);

  assert.match(result.clearCookie, /Expires=Thu, 01 Jan 1970/);
  assert.equal(await service.getCurrentUser(sessionToken), undefined);
});
