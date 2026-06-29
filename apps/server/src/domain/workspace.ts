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
