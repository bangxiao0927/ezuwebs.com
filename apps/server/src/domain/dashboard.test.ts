import test from "node:test";
import assert from "node:assert/strict";

import { getDashboard } from "./dashboard.js";
import { configureSessionRepository, createSession } from "./sessions.js";
import { createMemorySessionRepository } from "./session-repository.js";
import type { AuthUser } from "./auth/store.js";

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return { id: "user-a", email: "ada@example.com", plan: "free", ...overrides };
}

test("getDashboard returns the user's own projects and a matching count", async () => {
  configureSessionRepository(createMemorySessionRepository());
  const owned = await createSession("club-promo", "user-a");
  await createSession("club-promo", "user-b");

  const dashboard = await getDashboard(makeUser());

  assert.equal(dashboard.user.id, "user-a");
  assert.deepEqual(
    dashboard.projects.map((project) => project.id),
    [owned.id],
  );
  assert.equal(dashboard.counts.totalProjects, 1);
});

test("getDashboard returns an empty project list for a user with no sessions", async () => {
  configureSessionRepository(createMemorySessionRepository());

  const dashboard = await getDashboard(makeUser());

  assert.deepEqual(dashboard.projects, []);
  assert.equal(dashboard.counts.totalProjects, 0);
});

test("getDashboard never includes internal session fields such as events or webEditor state", async () => {
  configureSessionRepository(createMemorySessionRepository());
  await createSession("club-promo", "user-a");

  const dashboard = await getDashboard(makeUser());

  for (const project of dashboard.projects) {
    assert.equal("events" in project, false);
    assert.equal("webEditor" in project, false);
    assert.equal("viewModel" in project, false);
  }
});
