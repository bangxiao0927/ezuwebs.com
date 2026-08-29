import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { IdTokenVerificationError, verifyGoogleIdToken } from "./id-token.js";

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

function signIdToken(claims: Record<string, unknown>, options: { alg?: string; kid?: string } = {}): string {
  const header = { alg: options.alg ?? "RS256", kid: options.kid ?? kid, typ: "JWT" };
  const headerSegment = base64UrlEncode(JSON.stringify(header));
  const payloadSegment = base64UrlEncode(JSON.stringify(claims));
  const signedData = `${headerSegment}.${payloadSegment}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signedData), privateKey);
  return `${signedData}.${base64UrlEncode(signature)}`;
}

function baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "https://accounts.google.com",
    aud: "test-client-id",
    sub: "google-subject-123",
    email: "user@example.com",
    email_verified: true,
    nonce: "expected-nonce",
    exp: Math.floor(Date.now() / 1000) + 3600,
    name: "Ada Lovelace",
    picture: "https://example.com/avatar.png",
    ...overrides,
  };
}

function fetchJwks(): Promise<{ keys: Array<{ kty: string; kid: string; n: string; e: string }> }> {
  return Promise.resolve({ keys: [{ kty: jwk.kty, kid, n: jwk.n, e: jwk.e }] });
}

function verifyOptions(overrides: Partial<Parameters<typeof verifyGoogleIdToken>[1]> = {}) {
  return {
    audience: "test-client-id",
    expectedNonce: "expected-nonce",
    fetchJwks,
    ...overrides,
  };
}

test("verifyGoogleIdToken accepts a validly signed token with matching claims", async () => {
  const token = signIdToken(baseClaims());

  const claims = await verifyGoogleIdToken(token, verifyOptions());

  assert.equal(claims.sub, "google-subject-123");
  assert.equal(claims.email, "user@example.com");
  assert.equal(claims.emailVerified, true);
  assert.equal(claims.name, "Ada Lovelace");
});

test("verifyGoogleIdToken rejects a token signed with a key not present in JWKS", async () => {
  const token = signIdToken(baseClaims(), { kid: "unknown-key" });

  await assert.rejects(verifyGoogleIdToken(token, verifyOptions()), IdTokenVerificationError);
});

test("verifyGoogleIdToken rejects a tampered payload", async () => {
  const token = signIdToken(baseClaims());
  const [headerSegment, , signatureSegment] = token.split(".");
  const tamperedPayload = base64UrlEncode(JSON.stringify(baseClaims({ sub: "attacker-subject" })));
  const tampered = `${headerSegment}.${tamperedPayload}.${signatureSegment}`;

  await assert.rejects(verifyGoogleIdToken(tampered, verifyOptions()), IdTokenVerificationError);
});

test("verifyGoogleIdToken rejects an unexpected issuer", async () => {
  const token = signIdToken(baseClaims({ iss: "https://evil.example.com" }));

  await assert.rejects(verifyGoogleIdToken(token, verifyOptions()), IdTokenVerificationError);
});

test("verifyGoogleIdToken rejects an unexpected audience", async () => {
  const token = signIdToken(baseClaims({ aud: "someone-elses-client-id" }));

  await assert.rejects(verifyGoogleIdToken(token, verifyOptions()), IdTokenVerificationError);
});

test("verifyGoogleIdToken rejects an expired token", async () => {
  const token = signIdToken(baseClaims({ exp: Math.floor(Date.now() / 1000) - 10 }));

  await assert.rejects(verifyGoogleIdToken(token, verifyOptions()), IdTokenVerificationError);
});

test("verifyGoogleIdToken rejects a nonce mismatch", async () => {
  const token = signIdToken(baseClaims({ nonce: "wrong-nonce" }));

  await assert.rejects(verifyGoogleIdToken(token, verifyOptions()), IdTokenVerificationError);
});

test("verifyGoogleIdToken rejects an unverified email", async () => {
  const token = signIdToken(baseClaims({ email_verified: false }));

  await assert.rejects(verifyGoogleIdToken(token, verifyOptions()), IdTokenVerificationError);
});

test("verifyGoogleIdToken rejects a non-RS256 algorithm", async () => {
  const header = { alg: "none", kid, typ: "JWT" };
  const headerSegment = base64UrlEncode(JSON.stringify(header));
  const payloadSegment = base64UrlEncode(JSON.stringify(baseClaims()));
  const token = `${headerSegment}.${payloadSegment}.`;

  await assert.rejects(verifyGoogleIdToken(token, verifyOptions()), IdTokenVerificationError);
});
