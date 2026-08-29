import type { EzuDb, OpenDatabaseOptions, User } from "@ezu/db";

import type { AuthStore, AuthUser, GoogleIdentity } from "./store.js";

function toAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    email: user.email,
    ...(user.name ? { name: user.name } : {}),
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
  };
}

/**
 * Backs auth by @ezu/db. The module is dynamically imported on first use so
 * importing this file never loads the better-sqlite3 native binding.
 */
export function createSqliteAuthStore(options: OpenDatabaseOptions = {}): AuthStore {
  let dbPromise: Promise<EzuDb> | undefined;

  async function getDb(): Promise<EzuDb> {
    if (!dbPromise) {
      dbPromise = import("@ezu/db").then(({ openDatabase }) =>
        openDatabase({ runMigrations: true, ...options }),
      );
    }
    return dbPromise;
  }

  return {
    async findOrCreateGoogleUser(identity: GoogleIdentity) {
      const [db, { findOrCreateGoogleUser }] = await Promise.all([getDb(), import("@ezu/db")]);
      return toAuthUser(findOrCreateGoogleUser(db, identity));
    },
    async createAuthSession(input) {
      const [db, { createAuthSession }] = await Promise.all([getDb(), import("@ezu/db")]);
      createAuthSession(db, input);
    },
    async findUserByActiveSession(tokenHash: string) {
      const [db, { findUserByActiveSession }] = await Promise.all([getDb(), import("@ezu/db")]);
      const user = findUserByActiveSession(db, tokenHash);
      return user ? toAuthUser(user) : undefined;
    },
    async revokeAuthSession(tokenHash: string) {
      const [db, { revokeAuthSession }] = await Promise.all([getDb(), import("@ezu/db")]);
      revokeAuthSession(db, tokenHash);
    },
  };
}
