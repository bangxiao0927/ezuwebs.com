import test from "node:test";
import assert from "node:assert/strict";

import { parseCookies, serializeCookie } from "./cookies.js";

test("parseCookies reads name/value pairs from a Cookie header", () => {
  const cookies = parseCookies("ezu_session=abc123; ezu_oauth_txn=%7B%22a%22%3A1%7D");

  assert.equal(cookies["ezu_session"], "abc123");
  assert.equal(cookies["ezu_oauth_txn"], '{"a":1}');
});

test("parseCookies returns an empty object for a missing header", () => {
  assert.deepEqual(parseCookies(undefined), {});
});

test("serializeCookie emits HttpOnly, SameSite=Lax, and the requested max age", () => {
  const header = serializeCookie("ezu_session", "tok en", { maxAgeSeconds: 3600 });

  assert.match(header, /^ezu_session=tok%20en/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Max-Age=3600/);
});

test("serializeCookie with an expires date can clear a cookie", () => {
  const header = serializeCookie("ezu_session", "", { expires: new Date(0) });

  assert.match(header, /Expires=Thu, 01 Jan 1970/);
});
