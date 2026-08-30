import assert from "node:assert/strict";
import test from "node:test";

import { promptUsageLabel } from "./usageDisplay.js";

test("promptUsageLabel shows measured tokens for an actual charge", () => {
  assert.equal(promptUsageLabel({ metering: "actual", units: 500 }), "500 tokens");
});

test("promptUsageLabel never presents a fixed reservation as a token count", () => {
  assert.equal(
    promptUsageLabel({ metering: "estimated", units: 1 }),
    "token usage unavailable; fixed reservation estimate",
  );
});
