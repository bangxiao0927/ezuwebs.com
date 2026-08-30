import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface WorkspaceFileEntry {
  path: string;
  content: string;
}

export interface WorkspaceSnapshot {
  rootPath: string;
  files: WorkspaceFileEntry[];
}

const fileGlobs = [
  "README.md",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.base.json",
  "apps/agent/package.json",
  "apps/web/package.json",
  "apps/server/package.json",
];

const directoryGlobs = [
  "apps/agent/src",
  "apps/web/src",
  "apps/server/src",
  "packages",
];

function findRepoRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));

  while (current !== dirname(current)) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    current = dirname(current);
  }

  return process.cwd();
}

const repoRoot = findRepoRoot();

function toPosix(value: string): string {
  return value.split(sep).join("/");
}

function collectTypeScriptSources(root: string, into: Map<string, string>): void {
  if (!existsSync(root)) {
    return;
  }

  for (const entry of readdirSync(root)) {
    const absolute = join(root, entry);
    const info = statSync(absolute);

    if (info.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") {
        continue;
      }
      collectTypeScriptSources(absolute, into);
      continue;
    }

    if (/\.(ts|md|json|yaml)$/.test(entry) && !entry.endsWith(".test.ts")) {
      into.set(toPosix(relative(repoRoot, absolute)), readFileSync(absolute, "utf8"));
    }
  }
}

let cachedSnapshot: WorkspaceSnapshot | undefined;

export function getDefaultWorkspaceSnapshot(): WorkspaceSnapshot {
  if (cachedSnapshot) {
    return cachedSnapshot;
  }

  const files = new Map<string, string>();

  for (const relativePath of fileGlobs) {
    const absolute = resolve(repoRoot, relativePath);
    if (existsSync(absolute) && statSync(absolute).isFile()) {
      files.set(toPosix(relativePath), readFileSync(absolute, "utf8"));
    }
  }

  for (const relativeDir of directoryGlobs) {
    collectTypeScriptSources(resolve(repoRoot, relativeDir), files);
  }

  cachedSnapshot = {
    rootPath: ".",
    files: [...files.entries()]
      .map(([path, content]) => ({ path, content }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };

  return cachedSnapshot;
}

let cachedBaselineVersion: string | undefined;

/**
 * A short fingerprint of the default workspace snapshot's contents. Sessions
 * store this alongside their workspace file overrides so a stored diff can
 * be traced back to the baseline it was computed against.
 */
export function getWorkspaceBaselineVersion(): string {
  if (cachedBaselineVersion) {
    return cachedBaselineVersion;
  }

  const hash = createHash("sha256");
  for (const file of getDefaultWorkspaceSnapshot().files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  cachedBaselineVersion = hash.digest("hex");
  return cachedBaselineVersion;
}

export interface WorkspaceFileOverride {
  path: string;
  /** Null marks a tombstone: a baseline file this session has removed. */
  content: string | null;
}

/**
 * Reduces a full workspace file list to only the entries that differ from
 * the default snapshot, plus tombstones for baseline files that were
 * removed. Lets sessions avoid persisting a full copy of the shared
 * baseline snapshot.
 */
export function diffWorkspaceFilesFromBaseline(files: WorkspaceFileEntry[]): WorkspaceFileOverride[] {
  const baselineByPath = new Map(getDefaultWorkspaceSnapshot().files.map((file) => [file.path, file.content]));
  const currentByPath = new Map(files.map((file) => [file.path, file.content]));
  const overrides: WorkspaceFileOverride[] = [];

  for (const [path, content] of currentByPath) {
    if (baselineByPath.get(path) !== content) {
      overrides.push({ path, content });
    }
  }
  for (const path of baselineByPath.keys()) {
    if (!currentByPath.has(path)) {
      overrides.push({ path, content: null });
    }
  }
  return overrides;
}

/** Inverse of {@link diffWorkspaceFilesFromBaseline}: rebuilds the full file list from the baseline plus overrides. */
export function reconstructWorkspaceFilesFromBaseline(
  overrides: WorkspaceFileOverride[],
  baselineFiles: WorkspaceFileEntry[],
): WorkspaceFileEntry[] {
  const filesByPath = new Map(baselineFiles.map((file) => [file.path, file.content]));

  for (const override of overrides) {
    if (override.content === null) {
      filesByPath.delete(override.path);
    } else {
      filesByPath.set(override.path, override.content);
    }
  }

  return [...filesByPath.entries()]
    .map(([path, content]) => ({ path, content }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export class WorkspaceBaselineMissingError extends Error {}
export class WorkspaceBaselineCorruptedError extends Error {}

/** Serializes a baseline snapshot's files for storage alongside the version that fingerprints them. */
export function serializeWorkspaceBaselineFiles(files: WorkspaceFileEntry[]): string {
  return JSON.stringify(files);
}

function isWorkspaceFileEntry(value: unknown): value is WorkspaceFileEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["path"] === "string" && typeof candidate["content"] === "string";
}

/**
 * Parses a stored workspace baseline snapshot's JSON, throwing
 * {@link WorkspaceBaselineCorruptedError} rather than silently reconstructing
 * a session's workspace against malformed or unexpected data.
 */
export function parseWorkspaceBaselineFilesJson(version: string, filesJson: string): WorkspaceFileEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(filesJson);
  } catch (cause) {
    throw new WorkspaceBaselineCorruptedError(
      `Stored workspace baseline ${version} contained malformed JSON`,
      { cause },
    );
  }
  if (!Array.isArray(parsed) || !parsed.every(isWorkspaceFileEntry)) {
    throw new WorkspaceBaselineCorruptedError(
      `Stored workspace baseline ${version} did not contain an array of { path, content } file entries`,
    );
  }
  return parsed;
}
