export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  plan: string;
}

export interface GoogleIdentity {
  subject: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  avatarUrl?: string;
}

/** Persistence boundary for auth so the sqlite-backed implementation can be swapped for a fake in tests. */
export interface AuthStore {
  findOrCreateGoogleUser(identity: GoogleIdentity): Promise<AuthUser>;
  createAuthSession(input: { userId: string; tokenHash: string; expiresAt: Date }): Promise<void>;
  findUserByActiveSession(tokenHash: string): Promise<AuthUser | undefined>;
  revokeAuthSession(tokenHash: string): Promise<void>;
}
