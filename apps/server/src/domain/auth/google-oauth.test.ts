import test from "node:test";
import assert from "node:assert/strict";

import {
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  GoogleOAuthError,
  type GoogleOAuthConfig,
} from "./google-oauth.js";

const config: GoogleOAuthConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "https://app.example.com/api/auth/google/callback",
};

test("createAuthorizationRequest builds a Google authorization URL with PKCE S256 and fresh state/nonce", () => {
  const first = createAuthorizationRequest(config);
  const second = createAuthorizationRequest(config);

  assert.notEqual(first.state, second.state);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.codeVerifier, second.codeVerifier);

  const url = new URL(first.url);
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), config.clientId);
  assert.equal(url.searchParams.get("redirect_uri"), config.redirectUri);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), first.state);
  assert.equal(url.searchParams.get("nonce"), first.nonce);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge"));
  assert.notEqual(url.searchParams.get("code_challenge"), first.codeVerifier);
});

test("exchangeAuthorizationCode posts the code and verifier to Google's token endpoint", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id_token: "jwt-value", access_token: "at-value" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const result = await exchangeAuthorizationCode(
    config,
    { code: "auth-code", codeVerifier: "verifier-value" },
    fakeFetch,
  );

  assert.equal(result.id_token, "jwt-value");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://oauth2.googleapis.com/token");
  const body = calls[0]?.init?.body as string;
  const params = new URLSearchParams(body);
  assert.equal(params.get("grant_type"), "authorization_code");
  assert.equal(params.get("code"), "auth-code");
  assert.equal(params.get("code_verifier"), "verifier-value");
  assert.equal(params.get("client_secret"), config.clientSecret);
  assert.equal(params.get("redirect_uri"), config.redirectUri);
});

test("exchangeAuthorizationCode throws GoogleOAuthError when Google rejects the request", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;

  await assert.rejects(
    exchangeAuthorizationCode(config, { code: "bad-code", codeVerifier: "verifier" }, fakeFetch),
    GoogleOAuthError,
  );
});
