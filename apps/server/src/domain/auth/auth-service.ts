import { serializeCookie } from "../../http/cookies.js";
import {
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  type GoogleOAuthConfig,
} from "./google-oauth.js";
import { type FetchJwks, verifyGoogleIdToken } from "./id-token.js";
import { generateRandomToken } from "./pkce.js";
import type { AuthStore, AuthUser } from "./store.js";
import { hashSessionToken } from "./token-hash.js";

export class AuthFlowError extends Error {}

const SESSION_COOKIE_NAME = "ezu_session";
const TRANSACTION_COOKIE_NAME = "ezu_oauth_txn";
const TRANSACTION_TTL_SECONDS = 10 * 60;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AuthServiceConfig {
  google: GoogleOAuthConfig;
}

export interface AuthServiceDeps {
  store: AuthStore;
  fetchImpl?: typeof fetch;
  fetchJwks: FetchJwks;
  now?: () => Date;
  randomToken?: (byteLength?: number) => string;
}

interface OAuthTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface BeginGoogleLoginResult {
  redirectUrl: string;
  transactionCookie: string;
}

export interface CompleteGoogleLoginInput {
  code: string;
  state: string;
  transactionCookieValue: string | undefined;
}

export interface CompleteGoogleLoginResult {
  user: AuthUser;
  sessionCookie: string;
  clearTransactionCookie: string;
}

export class AuthService {
  readonly sessionCookieName = SESSION_COOKIE_NAME;
  readonly transactionCookieName = TRANSACTION_COOKIE_NAME;

  private readonly config: AuthServiceConfig;
  private readonly store: AuthStore;
  private readonly fetchImpl: typeof fetch;
  private readonly fetchJwks: FetchJwks;
  private readonly now: () => Date;
  private readonly randomToken: (byteLength?: number) => string;
  private readonly secureCookies: boolean;

  constructor(config: AuthServiceConfig, deps: AuthServiceDeps) {
    this.config = config;
    this.store = deps.store;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.fetchJwks = deps.fetchJwks;
    this.now = deps.now ?? (() => new Date());
    this.randomToken = deps.randomToken ?? generateRandomToken;
    this.secureCookies = new URL(config.google.redirectUri).protocol === "https:";
  }

  beginGoogleLogin(): BeginGoogleLoginResult {
    const authorizationRequest = createAuthorizationRequest(this.config.google, this.randomToken);
    const transaction: OAuthTransaction = {
      state: authorizationRequest.state,
      nonce: authorizationRequest.nonce,
      codeVerifier: authorizationRequest.codeVerifier,
    };
    return {
      redirectUrl: authorizationRequest.url,
      transactionCookie: serializeCookie(TRANSACTION_COOKIE_NAME, JSON.stringify(transaction), {
        maxAgeSeconds: TRANSACTION_TTL_SECONDS,
        secure: this.secureCookies,
      }),
    };
  }

  async completeGoogleLogin(input: CompleteGoogleLoginInput): Promise<CompleteGoogleLoginResult> {
    if (!input.transactionCookieValue) {
      throw new AuthFlowError("Missing OAuth transaction cookie");
    }

    let transaction: OAuthTransaction;
    try {
      transaction = JSON.parse(input.transactionCookieValue) as OAuthTransaction;
    } catch {
      throw new AuthFlowError("OAuth transaction cookie is malformed");
    }

    if (!transaction.state || transaction.state !== input.state) {
      throw new AuthFlowError("OAuth state does not match the transaction cookie");
    }

    const tokenResponse = await exchangeAuthorizationCode(
      this.config.google,
      { code: input.code, codeVerifier: transaction.codeVerifier },
      this.fetchImpl,
    );

    const claims = await verifyGoogleIdToken(tokenResponse.id_token, {
      audience: this.config.google.clientId,
      expectedNonce: transaction.nonce,
      fetchJwks: this.fetchJwks,
      now: () => Math.floor(this.now().getTime() / 1000),
    });

    const user = await this.store.findOrCreateGoogleUser({
      subject: claims.sub,
      email: claims.email,
      emailVerified: claims.emailVerified,
      ...(claims.name ? { name: claims.name } : {}),
      ...(claims.picture ? { avatarUrl: claims.picture } : {}),
    });

    const sessionToken = this.randomToken(32);
    const expiresAt = new Date(this.now().getTime() + SESSION_TTL_MS);
    await this.store.createAuthSession({
      userId: user.id,
      tokenHash: hashSessionToken(sessionToken),
      expiresAt,
    });

    return {
      user,
      sessionCookie: serializeCookie(SESSION_COOKIE_NAME, sessionToken, {
        maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
        secure: this.secureCookies,
      }),
      clearTransactionCookie: serializeCookie(TRANSACTION_COOKIE_NAME, "", {
        expires: new Date(0),
        secure: this.secureCookies,
      }),
    };
  }

  async getCurrentUser(sessionCookieValue: string | undefined): Promise<AuthUser | undefined> {
    if (!sessionCookieValue) {
      return undefined;
    }
    return this.store.findUserByActiveSession(hashSessionToken(sessionCookieValue));
  }

  async logout(sessionCookieValue: string | undefined): Promise<{ clearCookie: string }> {
    if (sessionCookieValue) {
      await this.store.revokeAuthSession(hashSessionToken(sessionCookieValue));
    }
    return {
      clearCookie: serializeCookie(SESSION_COOKIE_NAME, "", {
        expires: new Date(0),
        secure: this.secureCookies,
      }),
    };
  }
}
