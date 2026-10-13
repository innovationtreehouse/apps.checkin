/**
 * Lambda entry point. Invoked by the app with `{ action: "current" }` and weekly by
 * EventBridge with `{ action: "keepalive" }`. Deployed with reserved concurrency 1.
 */
import { run, type RefresherEvent, type RefresherToken } from "./refresher";
import { secretsManagerStore } from "./secret";

export async function handler(event: RefresherEvent): Promise<RefresherToken> {
  const secretId = process.env.QBO_SECRET_ID;
  if (!secretId) throw new Error("QBO_SECRET_ID must be set");
  return run(event, secretsManagerStore(secretId), process.env);
}
