import test from "node:test";
import assert from "node:assert/strict";

import { computeCodeChallengeS256, generateRandomToken } from "./pkce.js";

test("generateRandomToken produces url-safe tokens of sufficient length and uniqueness", () => {
  const first = generateRandomToken();
  const second = generateRandomToken();

  assert.notEqual(first, second);
  assert.match(first, /^[A-Za-z0-9_-]+$/);
  assert.ok(first.length >= 32);
});

test("computeCodeChallengeS256 matches the RFC 7636 worked example", () => {
  // Verifier and expected challenge from RFC 7636 appendix B.
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = computeCodeChallengeS256(verifier);

  assert.equal(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});
