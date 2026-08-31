import assert from "node:assert/strict";
import test from "node:test";

import { recentProjects } from "./recentProjects.js";
import type { DashboardProject } from "../types";

function project(id: string): DashboardProject {
  return { id, projectName: id, description: "", taskTitle: "", taskTimestamp: "" };
}

test("returns every project newest-first when under the cap", () => {
  const result = recentProjects([project("a"), project("b"), project("c")], 6);
  assert.deepEqual(
    result.map((entry) => entry.id),
    ["c", "b", "a"],
  );
});

test("keeps only the newest entries up to the cap", () => {
  const projects = ["a", "b", "c", "d", "e", "f", "g"].map(project);
  const result = recentProjects(projects, 3);
  assert.deepEqual(
    result.map((entry) => entry.id),
    ["g", "f", "e"],
  );
});

test("an empty list and a zero cap both yield nothing", () => {
  assert.deepEqual(recentProjects([], 6), []);
  assert.deepEqual(recentProjects([project("a")], 0), []);
});

test("does not mutate the input array", () => {
  const projects = [project("a"), project("b")];
  recentProjects(projects, 6);
  assert.deepEqual(
    projects.map((entry) => entry.id),
    ["a", "b"],
  );
});
