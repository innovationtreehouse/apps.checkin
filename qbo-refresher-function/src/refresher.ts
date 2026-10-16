import type { QboEnv, QboTokens } from "@inventory/quickbooks";
import { refreshTokens } from "@inventory/quickbooks/oauth";

/** The secret's JSON: the Intuit app keys plus the live token pair. Only this function reads it. */
export interface StoredCredentials extends QboTokens {
  clientId: string;
  clientSecret: string;
}

export interface CredentialStore {
  load(): Promise<StoredCredentials>;
  save(creds: StoredCredentials): Promise<void>;
}

/** What `{ action: "current" }` returns to the app. clientId is not secret; the app re-checks it. */
export interface RefresherToken {
  accessToken: string;
  expiresAt: number; // epoch ms
  realmId: string;
  clientId: string;
}

export interface RefresherEvent {
  action?: string;
}

export interface RefresherEnv {
  QBO_ENVIRONMENT?: string;
  QBO_DEV_CLIENT_ID?: string;
}

/** Twice the app's own 5-minute margin, so a returned token always clears the app's cache check despite clock skew. */
export const REFRESH_MARGIN_MS = 10 * 60_000;

/** Log marker the invalid_grant alarm's metric filter matches. */
export const INVALID_GRANT_MARKER = "QBO_INVALID_GRANT";

export function expiresAt(t: QboTokens): number {
  return t.obtainedAt + t.expiresIn * 1000;
}

/**
 * Intuit development keys open only sandbox companies, so outside production the
 * function must hold exactly the dev client id, and production must never hold it.
 */
export function assertClientIdAllowed(clientId: string, env: RefresherEnv): QboEnv {
  const qboEnv = env.QBO_ENVIRONMENT;
  if (qboEnv !== "sandbox" && qboEnv !== "production") {
    throw new Error(`QBO_ENVIRONMENT must be "sandbox" or "production", got ${JSON.stringify(qboEnv)}`);
  }
  const devClientId = env.QBO_DEV_CLIENT_ID;
  if (!devClientId) throw new Error("QBO_DEV_CLIENT_ID must be set");
  if (qboEnv === "production" && clientId === devClientId) {
    throw new Error("refusing Intuit development keys in production");
  }
  if (qboEnv === "sandbox" && clientId !== devClientId) {
    throw new Error("outside production the client id must be QBO_DEV_CLIENT_ID");
  }
  return qboEnv;
}

async function refresh(creds: StoredCredentials): Promise<StoredCredentials> {
  try {
    const next = await refreshTokens({ clientId: creds.clientId, clientSecret: creds.clientSecret, redirectUri: "" }, creds);
    return { ...creds, ...next };
  } catch (err) {
    // A revoked or expired refresh token needs an operator to re-consent; retrying cannot help.
    if (err instanceof Error && err.message.includes("invalid_grant")) {
      console.error(`${INVALID_GRANT_MARKER}: QuickBooks refresh token rejected; re-run consent`, { realmId: creds.realmId });
    }
    throw err;
  }
}

/** Backoff before each retry of the secret write; the attempt count is this length + 1. */
export const SAVE_RETRY_DELAYS_MS = [200, 1000, 3000];

/**
 * Intuit has already rotated the pair, so the old refresh token is dead: a write lost here
 * means a manual reconnect. Retry it in this invocation, then raise the same alarm.
 */
async function saveRotated(store: CredentialStore, creds: StoredCredentials): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await store.save(creds);
    } catch (err) {
      if (attempt >= SAVE_RETRY_DELAYS_MS.length) {
        console.error(`${INVALID_GRANT_MARKER}: rotated QuickBooks token could not be saved; re-run consent`, { realmId: creds.realmId });
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, SAVE_RETRY_DELAYS_MS[attempt]));
    }
  }
}

/**
 * `current` returns a usable access token, refreshing only near expiry. `keepalive` (weekly
 * EventBridge) always refreshes, so an idle refresh token never reaches Intuit's 100-day expiry.
 * Reserved concurrency 1 makes this the single writer of the secret.
 */
export async function run(
  event: RefresherEvent,
  store: CredentialStore,
  env: RefresherEnv,
  now: number = Date.now(),
): Promise<RefresherToken> {
  if (event.action !== "current" && event.action !== "keepalive") {
    throw new Error(`unknown action ${JSON.stringify(event.action)}`);
  }
  let creds = await store.load();
  assertClientIdAllowed(creds.clientId, env);
  if (event.action === "keepalive" || expiresAt(creds) - now < REFRESH_MARGIN_MS) {
    creds = await refresh(creds);
    await saveRotated(store, creds);
  }
  return { accessToken: creds.accessToken, expiresAt: expiresAt(creds), realmId: creds.realmId, clientId: creds.clientId };
}
