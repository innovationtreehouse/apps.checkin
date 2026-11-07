/**
 * The receipt mailbox's access token, from the Gmail token refresher Lambda, kept until near
 * expiry. One cache per refresher and mailbox, shared by mail intake and System Status. The
 * refresher alone holds the refresh token; its answer must name our mailbox.
 */
import { z } from "zod";
import { invokeRefresher } from "@/lib/tokenRefresher";

/** Re-ask the refresher this long before the token it handed out expires. */
const TOKEN_MARGIN_MS = 5 * 60_000;

/** Shown on System Status and carried by mail intake's failure while the login is revoked. */
export const GMAIL_RECONNECT = "The receipt mailbox needs reconnecting: its Gmail login was revoked. Ops reconnects it by re-running the Gmail consent.";

const RefresherAnswer = z.object({ accessToken: z.string().min(1), expiresAt: z.number(), mailbox: z.string() });

export type InvokeGmailRefresher = (functionName: string) => Promise<unknown>;

const invokeLambda: InvokeGmailRefresher = (functionName) =>
  invokeRefresher({ functionName, service: "Gmail token refresher", reconnect: GMAIL_RECONNECT });

/** A token getter for one refresher and mailbox; `invoke` is for tests. */
export function gmailTokenSource(functionName: string, mailboxAddress: string, invoke: InvokeGmailRefresher = invokeLambda): () => Promise<string> {
  let cached: z.infer<typeof RefresherAnswer> | null = null;
  return async () => {
    if (cached && Date.now() < cached.expiresAt - TOKEN_MARGIN_MS) return cached.accessToken;
    const answer = RefresherAnswer.parse(await invoke(functionName));
    if (answer.mailbox.toLowerCase() !== mailboxAddress.toLowerCase()) throw new Error("Gmail token refresher holds a different mailbox");
    cached = answer;
    return answer.accessToken;
  };
}

let shared: { key: string; current: () => Promise<string> } | null = null;

export function gmailAccessToken(mailbox: { functionName: string; mailboxAddress: string }): () => Promise<string> {
  const key = `${mailbox.functionName}|${mailbox.mailboxAddress}`;
  if (shared?.key !== key) shared = { key, current: gmailTokenSource(mailbox.functionName, mailbox.mailboxAddress) };
  return shared.current;
}
