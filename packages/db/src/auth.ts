import { and, eq, gt, isNull } from "drizzle-orm";

import type { EzuDb } from "./client.js";
import { authSessions, oauthAccounts, users, type User } from "./schema.js";

export interface GoogleIdentity {
  subject: string;
  email: string;
  name?: string;
  avatarUrl?: string;
}

export function findOrCreateGoogleUser(db: EzuDb, identity: GoogleIdentity): User {
  return db.transaction((tx) => {
    const account = tx
      .select()
      .from(oauthAccounts)
      .where(and(eq(oauthAccounts.provider, "google"), eq(oauthAccounts.providerSubject, identity.subject)))
      .get();
    const now = new Date();

    if (account) {
      const user = tx
        .update(users)
        .set({
          email: identity.email,
          name: identity.name ?? null,
          avatarUrl: identity.avatarUrl ?? null,
          updatedAt: now,
        })
        .where(eq(users.id, account.userId))
        .returning()
        .get();
      if (!user) throw new Error("OAuth user no longer exists");
      return user;
    }

    // Never auto-link a new provider subject to an existing email account.
    const emailOwner = tx.select().from(users).where(eq(users.email, identity.email)).get();
    if (emailOwner) throw new Error("An account with this email already exists; explicit linking is required");

    const userId = crypto.randomUUID();
    const user = tx
      .insert(users)
      .values({
        id: userId,
        email: identity.email,
        name: identity.name ?? null,
        avatarUrl: identity.avatarUrl ?? null,
        plan: "free",
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    tx.insert(oauthAccounts).values({
      id: crypto.randomUUID(),
      userId,
      provider: "google",
      providerSubject: identity.subject,
      email: identity.email,
      createdAt: now,
      updatedAt: now,
    }).run();
    return user;
  });
}

export function createAuthSession(
  db: EzuDb,
  input: { userId: string; tokenHash: string; expiresAt: Date },
): void {
  db.insert(authSessions).values({
    id: crypto.randomUUID(),
    userId: input.userId,
    tokenHash: input.tokenHash,
    expiresAt: input.expiresAt,
    createdAt: new Date(),
  }).run();
}

export function findUserByActiveSession(db: EzuDb, tokenHash: string): User | undefined {
  return db
    .select({ user: users })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(
      and(
        eq(authSessions.tokenHash, tokenHash),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, new Date()),
      ),
    )
    .get()?.user;
}

export function revokeAuthSession(db: EzuDb, tokenHash: string): void {
  db.update(authSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(authSessions.tokenHash, tokenHash), isNull(authSessions.revokedAt)))
    .run();
}
