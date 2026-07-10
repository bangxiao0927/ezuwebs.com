import { eq } from "drizzle-orm";

import type { EzuDb } from "./client.js";
import { users, type User } from "./schema.js";

export interface CreateUserInput {
  email: string;
  name?: string | undefined;
  avatarUrl?: string | undefined;
  plan?: string | undefined;
  id?: string | undefined;
}

export function createUser(db: EzuDb, input: CreateUserInput): User {
  const now = new Date();
  const id = input.id ?? crypto.randomUUID();
  const created = db
    .insert(users)
    .values({
      id,
      email: input.email,
      name: input.name ?? null,
      avatarUrl: input.avatarUrl ?? null,
      plan: input.plan ?? "free",
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  if (!created) {
    throw new Error("Failed to insert user");
  }
  return created;
}

export function findUserById(db: EzuDb, id: string): User | undefined {
  return db.select().from(users).where(eq(users.id, id)).get();
}

export function findUserByEmail(db: EzuDb, email: string): User | undefined {
  return db.select().from(users).where(eq(users.email, email)).get();
}
