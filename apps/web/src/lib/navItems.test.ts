import assert from "node:assert/strict";
import test from "node:test";

import { NAV_ITEMS, navItemActive } from "./navItems.js";

test("navItemActive matches the active page against a nav item", () => {
  assert.equal(navItemActive("dashboard", "dashboard"), true);
});

test("navItemActive is false when the active page differs from the nav item", () => {
  assert.equal(navItemActive("dashboard", "credits"), false);
});

test("navItemActive is false for pages with no matching top-level nav item", () => {
  assert.equal(navItemActive("select", "home"), false);
  assert.equal(navItemActive("session", "dashboard"), false);
});

test("NAV_ITEMS lists Home, Dashboard, Credits, Usage in that order", () => {
  assert.deepEqual(
    NAV_ITEMS.map((item) => item.id),
    ["home", "dashboard", "credits", "usage"],
  );
});
