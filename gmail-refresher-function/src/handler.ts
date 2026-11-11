/**
 * Lambda entry point. Invoked by the app with `{ action: "current" }` and weekly by
 * EventBridge with `{ action: "keepalive" }`.
 */
import { run, type RefresherEvent, type RefresherToken } from "./refresher";
import { secretsManagerStore } from "./secret";

export async function handler(event: RefresherEvent): Promise<RefresherToken> {
  const { GMAIL_CLIENT_SECRET_ID: clientSecretId, GMAIL_TOKEN_SECRET_ID: tokenSecretId } = process.env;
  if (!clientSecretId || !tokenSecretId) throw new Error("GMAIL_CLIENT_SECRET_ID and GMAIL_TOKEN_SECRET_ID must be set");
  return run(event, secretsManagerStore(clientSecretId, tokenSecretId));
}
