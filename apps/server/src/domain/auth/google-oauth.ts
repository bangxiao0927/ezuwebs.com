import { computeCodeChallengeS256, generateRandomToken } from "./pkce.js";

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface AuthorizationRequest {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export function createAuthorizationRequest(
  config: GoogleOAuthConfig,
  randomToken: (byteLength?: number) => string = generateRandomToken,
): AuthorizationRequest {
  const state = randomToken();
  const nonce = randomToken();
  const codeVerifier = randomToken(32);
  const codeChallenge = computeCodeChallengeS256(codeVerifier);

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return {
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    state,
    nonce,
    codeVerifier,
  };
}

export interface TokenExchangeInput {
  code: string;
  codeVerifier: string;
}

export interface GoogleTokenResponse {
  id_token: string;
  access_token?: string;
  expires_in?: number;
  token_type?: string;
}

export class GoogleOAuthError extends Error {}

export async function exchangeAuthorizationCode(
  config: GoogleOAuthConfig,
  input: TokenExchangeInput,
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: input.codeVerifier,
  });

  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new GoogleOAuthError(`Google token exchange failed with status ${response.status}`);
  }

  const payload = (await response.json()) as GoogleTokenResponse;
  if (!payload.id_token) {
    throw new GoogleOAuthError("Google token response did not include an id_token");
  }
  return payload;
}
