import { AuthService } from "./auth-service.js";
import type { GoogleJsonWebKey } from "./id-token.js";
import { createSqliteAuthStore } from "./sqlite-auth-store.js";

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set to enable Google sign-in`);
  }
  return value;
}

/**
 * Builds the production AuthService. Only invoked lazily by the router on the
 * first /api/auth/* request so importing the router never loads better-sqlite3.
 */
export function createDefaultAuthService(): AuthService {
  return new AuthService(
    {
      google: {
        clientId: requiredEnv("GOOGLE_CLIENT_ID"),
        clientSecret: requiredEnv("GOOGLE_CLIENT_SECRET"),
        redirectUri: requiredEnv("GOOGLE_REDIRECT_URI"),
      },
    },
    {
      store: createSqliteAuthStore(),
      fetchJwks: async () => {
        const response = await fetch(GOOGLE_JWKS_URL);
        if (!response.ok) {
          throw new Error(`Failed to fetch Google JWKS: ${response.status}`);
        }
        return (await response.json()) as { keys: GoogleJsonWebKey[] };
      },
    },
  );
}
