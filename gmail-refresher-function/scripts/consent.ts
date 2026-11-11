// One-time gmail.readonly consent, run by an operator. Catches Google's redirect on a local server,
// proves the grant opens the named mailbox, and writes the token secret's JSON to a new 0600 file.
// Run: npm run consent -w gmail-refresher-function
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createGmailReader } from "@checkin/receipt/gmail";
import { authUrl, exchangeCode } from "../src/oauth";

const { GMAIL_CLIENT_ID: clientId, GMAIL_CLIENT_SECRET: clientSecret, GMAIL_MAILBOX: mailbox } = process.env;
if (!clientId || !clientSecret || !mailbox) throw new Error("GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_MAILBOX must be set");
const redirectUri = process.env.GMAIL_REDIRECT_URI ?? "http://localhost:8087/callback";
const tokenFile = process.env.GMAIL_TOKEN_FILE ?? "gmail-token.json";
// The final write refuses an existing file, by which point the one-time code is already spent.
if (existsSync(tokenFile)) throw new Error(`${tokenFile} already exists; seed the secret from it or delete it, then re-run`);
const state = randomBytes(16).toString("hex");
const redirect = new URL(redirectUri);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", redirectUri);
  if (url.pathname !== redirect.pathname) {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get("code");
  if (url.searchParams.get("state") !== state || !code) {
    res.writeHead(400).end("state mismatch or missing code, aborting");
    console.error("state mismatch or missing code, aborting");
    process.exitCode = 1;
  } else {
    try {
      const { accessToken, refreshToken } = await exchangeCode({ clientId, clientSecret }, code, redirectUri);
      // Gmail refuses a request naming any mailbox but the token's own.
      await createGmailReader(mailbox, async () => accessToken).listRecent(1);
      writeFileSync(tokenFile, JSON.stringify({ refreshToken, mailbox }), { mode: 0o600, flag: "wx" });
      res.writeHead(200).end("Mailbox connected. You can close this tab.");
      console.log(`\nConnected ${mailbox}. Token secret JSON written to ${tokenFile}. Seed the secret from it, then delete it.`);
    } catch (err) {
      res.writeHead(500).end("Consent failed; see the terminal.");
      console.error(err instanceof Error ? err.message : "consent failed");
      process.exitCode = 1;
    }
  }
  server.close();
  // Browser keep-alive sockets keep the event loop alive; force exit once the response flushes.
  setTimeout(() => process.exit(process.exitCode ?? 0), 300);
});

server.listen(Number(redirect.port || 80), () => {
  console.log(`Open this URL and sign in as ${mailbox}:\n`);
  console.log(authUrl(clientId, redirectUri, mailbox, state));
  console.log(`\nWaiting for redirect on ${redirectUri} ...`);
});
