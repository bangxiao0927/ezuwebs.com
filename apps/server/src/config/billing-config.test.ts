import test from "node:test";
import assert from "node:assert/strict";

import { resolveBillingEnabled } from "./billing-config.js";

test("resolveBillingEnabled honors an explicit BILLING_ENABLED=true override", () => {
  assert.equal(resolveBillingEnabled({ BILLING_ENABLED: "true" }), true);
});

test("resolveBillingEnabled honors an explicit BILLING_ENABLED=false override", () => {
  assert.equal(
    resolveBillingEnabled({
      BILLING_ENABLED: "false",
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      GOOGLE_REDIRECT_URI: "https://example.com/callback",
    }),
    false,
  );
});

test("resolveBillingEnabled defaults to true when Google auth is fully configured", () => {
  assert.equal(
    resolveBillingEnabled({
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      GOOGLE_REDIRECT_URI: "https://example.com/callback",
    }),
    true,
  );
});

test("resolveBillingEnabled defaults to false when Google auth is not fully configured", () => {
  assert.equal(resolveBillingEnabled({}), false);
  assert.equal(resolveBillingEnabled({ GOOGLE_CLIENT_ID: "id" }), false);
});
