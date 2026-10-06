// One-time OAuth consent. Starts a local server to catch Intuit's redirect, exchanges the
// code for tokens, and saves them. Run: npm run consent -w @inventory/quickbooks
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { oauthConfigFromEnv, authUrl, exchangeCode, saveTokens } from "../src/oauth";

const cfg = oauthConfigFromEnv();
const state = randomBytes(16).toString("hex");
const port = Number(new URL(cfg.redirectUri).port || 80);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", cfg.redirectUri);
  if (url.pathname !== new URL(cfg.redirectUri).pathname) {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get("code");
  const realmId = url.searchParams.get("realmId");
  const returnedState = url.searchParams.get("state");

  if (returnedState !== state) {
    res.writeHead(400).end("state mismatch — possible CSRF, aborting");
    console.error("state mismatch, aborting");
    server.close();
    process.exitCode = 1;
    return;
  }
  if (!code || !realmId) {
    res.writeHead(400).end("missing code or realmId");
    return;
  }

  try {
    const tokens = await exchangeCode(cfg, code, realmId);
    saveTokens(tokens);
    res.writeHead(200).end("QuickBooks connected. Tokens saved. You can close this tab.");
    console.log(`\n✓ Connected. realmId=${realmId}. Tokens saved to .qbo-tokens.json (gitignored).`);
  } catch (err) {
    res.writeHead(500).end(String(err));
    console.error(err);
    process.exitCode = 1;
  } finally {
    server.close();
    // Browser keep-alive sockets keep the event loop alive; force exit once the response flushes.
    setTimeout(() => process.exit(process.exitCode ?? 0), 300);
  }
});

server.listen(port, () => {
  console.log("Open this URL in your browser to authorize (sign in to the sandbox/production company):\n");
  console.log(authUrl(cfg, state));
  console.log(`\nWaiting for redirect on ${cfg.redirectUri} ...`);
});
