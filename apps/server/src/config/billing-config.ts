export interface BillingConfigEnv {
  BILLING_ENABLED?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
}

function isGoogleAuthConfigured(env: BillingConfigEnv): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI);
}

/**
 * Whether billed agent actions require an authenticated user. An explicit
 * BILLING_ENABLED env var always wins; otherwise billing follows whether
 * Google sign-in is fully configured, since without it no user can ever
 * authenticate to pay for usage.
 */
export function resolveBillingEnabled(env: BillingConfigEnv): boolean {
  if (env.BILLING_ENABLED === "true") {
    return true;
  }
  if (env.BILLING_ENABLED === "false") {
    return false;
  }
  return isGoogleAuthConfigured(env);
}
