import test from "node:test";
import assert from "node:assert/strict";

import {
  diffWorkspaceFilesFromBaseline,
  getDefaultWorkspaceSnapshot,
  getWorkspaceBaselineVersion,
  parseWorkspaceBaselineFilesJson,
  reconstructWorkspaceFilesFromBaseline,
  serializeWorkspaceBaselineFiles,
  WorkspaceBaselineCorruptedError,
} from "./workspace.js";

test("diffWorkspaceFilesFromBaseline returns no overrides for an unmodified baseline", () => {
  const baseline = getDefaultWorkspaceSnapshot();

  assert.deepEqual(diffWorkspaceFilesFromBaseline(baseline.files), []);
});

test("diffWorkspaceFilesFromBaseline captures changed content, added files, and removed baseline files", () => {
  const baseline = getDefaultWorkspaceSnapshot();
  const changedPath = baseline.files[0]!.path;
  const removedPath = baseline.files[1]!.path;
  const modified = baseline.files
    .filter((file) => file.path !== removedPath)
    .map((file) => (file.path === changedPath ? { path: file.path, content: "changed content" } : file));
  modified.push({ path: "new-file.txt", content: "brand new" });

  const overrides = diffWorkspaceFilesFromBaseline(modified);

  assert.deepEqual(
    overrides.find((override) => override.path === changedPath),
    { path: changedPath, content: "changed content" },
  );
  assert.deepEqual(
    overrides.find((override) => override.path === "new-file.txt"),
    { path: "new-file.txt", content: "brand new" },
  );
  assert.deepEqual(
    overrides.find((override) => override.path === removedPath),
    { path: removedPath, content: null },
  );
});

test("reconstructWorkspaceFilesFromBaseline is the inverse of diffWorkspaceFilesFromBaseline", () => {
  const baseline = getDefaultWorkspaceSnapshot();
  const changedPath = baseline.files[0]!.path;
  const removedPath = baseline.files[1]!.path;
  const modified = baseline.files
    .filter((file) => file.path !== removedPath)
    .map((file) => (file.path === changedPath ? { path: file.path, content: "changed content" } : file))
    .concat([{ path: "new-file.txt", content: "brand new" }])
    .sort((left, right) => left.path.localeCompare(right.path));

  const overrides = diffWorkspaceFilesFromBaseline(modified);
  const reconstructed = reconstructWorkspaceFilesFromBaseline(overrides, baseline.files);

  assert.deepEqual(reconstructed, modified);
});

test("reconstructWorkspaceFilesFromBaseline rebuilds from a stored baseline snapshot, not the current deploy baseline", () => {
  const storedBaselineFiles = [
    { path: "a.txt", content: "stored a" },
    { path: "b.txt", content: "stored b" },
  ];
  const overrides = [{ path: "a.txt", content: "edited a" }];

  const reconstructed = reconstructWorkspaceFilesFromBaseline(overrides, storedBaselineFiles);

  assert.deepEqual(reconstructed, [
    { path: "a.txt", content: "edited a" },
    { path: "b.txt", content: "stored b" },
  ]);
});

test("getWorkspaceBaselineVersion is a stable, non-empty fingerprint", () => {
  const first = getWorkspaceBaselineVersion();
  const second = getWorkspaceBaselineVersion();

  assert.ok(first.length > 0);
  assert.equal(first, second);
});

test("parseWorkspaceBaselineFilesJson round-trips serializeWorkspaceBaselineFiles", () => {
  const files = [{ path: "a.txt", content: "hello" }];

  const parsed = parseWorkspaceBaselineFilesJson("v1", serializeWorkspaceBaselineFiles(files));

  assert.deepEqual(parsed, files);
});

test("parseWorkspaceBaselineFilesJson throws WorkspaceBaselineCorruptedError on malformed JSON", () => {
  assert.throws(
    () => parseWorkspaceBaselineFilesJson("v1", "not json"),
    WorkspaceBaselineCorruptedError,
  );
});

test("parseWorkspaceBaselineFilesJson throws WorkspaceBaselineCorruptedError when entries are not { path, content }", () => {
  assert.throws(
    () => parseWorkspaceBaselineFilesJson("v1", JSON.stringify([{ path: "a.txt" }])),
    WorkspaceBaselineCorruptedError,
  );
  assert.throws(
    () => parseWorkspaceBaselineFilesJson("v1", JSON.stringify({ path: "a.txt", content: "x" })),
    WorkspaceBaselineCorruptedError,
  );
});
