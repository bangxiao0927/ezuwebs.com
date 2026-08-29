import assert from "node:assert/strict";
import test from "node:test";

import { hasNextPage, nextOffset, previousOffset } from "./usagePagination.js";

test("nextOffset advances by a full page", () => {
  assert.equal(nextOffset(0, 20), 20);
});

test("previousOffset steps back by a full page without going negative", () => {
  assert.equal(previousOffset(20, 20), 0);
  assert.equal(previousOffset(10, 20), 0);
});

test("hasNextPage is false once the current page reaches the total", () => {
  assert.equal(hasNextPage(0, 20, 20), false);
  assert.equal(hasNextPage(0, 20, 21), true);
});
