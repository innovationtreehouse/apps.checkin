import { refreshAccessToken, type OauthClient } from "./oauth";

/** The per-environment token secret: the grant and the mailbox it belongs to. */
export interface StoredGrant {
  refreshToken: string;
  mailbox: string;
}

export interface CredentialStore {
  loadClient(): Promise<OauthClient>;
  loadGrant(): Promise<StoredGrant>;
}

/** What the app receives; it refuses a token whose mailbox is not its own. */
export interface RefresherToken {
  accessToken: string;
  expiresAt: number; // epoch ms
  mailbox: string;
}

export interface RefresherEvent {
  action?: string;
}

/** Log marker the invalid_grant alarm's metric filter matches. */
export const INVALID_GRANT_MARKER = "GMAIL_INVALID_GRANT";

/**
 * Every call refreshes and nothing is written back: Google keeps the refresh token valid across
 * refreshes, and the app caches the access token. The weekly `keepalive` exists so that an idle
 * grant keeps being used and does not lapse.
 */
export async function run(event: RefresherEvent, store: CredentialStore): Promise<RefresherToken> {
  if (event.action !== "current" && event.action !== "keepalive") {
    throw new Error(`unknown action ${JSON.stringify(event.action)}`);
  }
  const [client, grant] = await Promise.all([store.loadClient(), store.loadGrant()]);
  const requestedAt = Date.now();
  try {
    const { accessToken, expiresIn } = await refreshAccessToken(client, grant.refreshToken);
    return { accessToken, expiresAt: requestedAt + expiresIn * 1000, mailbox: grant.mailbox };
  } catch (err) {
    // A revoked or lapsed grant needs an operator to re-consent; retrying cannot help.
    if (err instanceof Error && err.message.includes("invalid_grant")) {
      console.error(`${INVALID_GRANT_MARKER}: Gmail refresh token rejected; re-run consent`);
    }
    throw err;
  }
}
