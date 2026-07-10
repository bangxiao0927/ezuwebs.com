import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import * as schema from "./schema.js";

export type EzuDb = BetterSQLite3Database<typeof schema>;

function resolveSqliteFilePath(databaseUrl: string): string {
  if (databaseUrl.startsWith("file:")) {
    return databaseUrl.slice("file:".length);
  }
  return databaseUrl;
}

export interface OpenDatabaseOptions {
  /** SQLite URL or path, e.g. `file:./data/app.db` or `:memory:` */
  databaseUrl?: string;
  /** When true, run SQL migrations from `packages/db/drizzle` (Node only). */
  runMigrations?: boolean;
}

/**
 * Opens a SQLite database and returns a Drizzle client.
 * Ensures parent directory exists for file-backed databases.
 */
export function openDatabase(options: OpenDatabaseOptions = {}): EzuDb {
  const databaseUrl = options.databaseUrl ?? process.env["DATABASE_URL"] ?? "file:./data/local.db";
  const filePath = resolveSqliteFilePath(databaseUrl);

  if (filePath !== ":memory:") {
    const dir = path.dirname(path.resolve(filePath));
    fs.mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(filePath);
  const db = drizzle(sqlite, { schema });

  if (options.runMigrations) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const migrationsFolder = path.join(here, "..", "drizzle");
    migrate(db, { migrationsFolder });
  }

  return db;
}
