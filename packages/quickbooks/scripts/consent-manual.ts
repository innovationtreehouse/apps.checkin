// Production consent without a local server: production redirect URIs must be https on a real
// domain (Intuit rejects localhost), and the page needn't work — the browser just lands there
// with ?code=...&realmId=... in the address bar. You paste that URL; this exchanges the code.
//
// Set QBO_REDIRECT_URI to the EXACT https URI registered in the production app, then:
//   npm run consent:manual -w @inventory/quickbooks
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { oauthConfigFromEnv, authUrl, exchangeCode } from "../src/oauth";
import { saveTokens, tokenFileFromEnv } from "../src/local";

const cfg = oauthConfigFromEnv();
const tokenFile = tokenFileFromEnv();
const state = randomBytes(16).toString("hex");

console.log("1. Open this URL, sign in to your company, and authorize:\n");
console.log(authUrl(cfg, state));
console.log("\n2. Your browser will land on the redirect URI (a 404 / error page is fine).");
console.log("   Copy the FULL URL from the address bar and paste it below.\n");

const rl = createInterface({ input: process.stdin, output: process.stdout });
const pasted = (await rl.question("Paste redirected URL: ")).trim();
rl.close();

const url = new URL(pasted);
const code = url.searchParams.get("code");
const realmId = url.searchParams.get("realmId");
const returnedState = url.searchParams.get("state");

if (returnedState !== state) throw new Error("state mismatch — paste the URL from THIS run's authorization");
if (!code || !realmId) throw new Error("URL missing code or realmId — paste the full redirected URL");

const tokens = await exchangeCode(cfg, code, realmId);
saveTokens(tokenFile, tokens);
console.log(`\n✓ Connected. realmId=${realmId}. Tokens saved to ${tokenFile}.`);
