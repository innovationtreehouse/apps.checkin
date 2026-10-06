import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { QboTokens } from "./types";

const AUTH_HOST = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const SCOPE = "com.intuit.quickbooks.accounting";

export interface OauthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function oauthConfigFromEnv(): OauthConfig {
  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  const redirectUri = process.env.QBO_REDIRECT_URI ?? "http://localhost:8087/callback";
  if (!clientId || !clientSecret) throw new Error("QBO_CLIENT_ID and QBO_CLIENT_SECRET must be set");
  return { clientId, clientSecret, redirectUri };
}

export function authUrl(cfg: OauthConfig, state: string): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    scope: SCOPE,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    state,
  });
  return `${AUTH_HOST}?${q}`;
}

function basicAuth(cfg: OauthConfig): string {
  return Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
}

async function tokenRequest(cfg: OauthConfig, body: URLSearchParams): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth(cfg)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  if (!res.ok) throw new Error(`QBO token request failed ${res.status} (intuit_tid=${res.headers.get("intuit_tid")}): ${await res.text()}`);
  return res.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number }>;
}

export async function exchangeCode(cfg: OauthConfig, code: string, realmId: string): Promise<QboTokens> {
  const t = await tokenRequest(cfg, new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
  }));
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresIn: t.expires_in, obtainedAt: Date.now(), realmId };
}

export async function refreshTokens(cfg: OauthConfig, tokens: QboTokens): Promise<QboTokens> {
  const t = await tokenRequest(cfg, new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
  }));
  return { ...tokens, accessToken: t.access_token, refreshToken: t.refresh_token, expiresIn: t.expires_in, obtainedAt: Date.now() };
}

// Refresh 60s before the access token actually expires.
export function isExpired(tokens: QboTokens, now: number = Date.now()): boolean {
  return now >= tokens.obtainedAt + (tokens.expiresIn - 60) * 1000;
}

const TOKEN_FILE = process.env.QBO_TOKEN_FILE ?? new URL("../.qbo-tokens.json", import.meta.url).pathname;

export function saveTokens(tokens: QboTokens): void {
  writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

export function loadTokens(): QboTokens | null {
  if (!existsSync(TOKEN_FILE)) return null;
  return JSON.parse(readFileSync(TOKEN_FILE, "utf-8")) as QboTokens;
}
