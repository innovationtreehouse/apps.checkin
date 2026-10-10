// Local-dev and operator-CLI token handling. Production injects its own
// read-only AccessTokenSource and never touches these.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { isExpired, oauthConfigFromEnv, refreshTokens } from "./oauth";
import type { AccessTokenSource, QboTokens } from "./types";

export function saveTokens(path: string, tokens: QboTokens): void {
  writeFileSync(path, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

export function loadTokens(path: string): QboTokens | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as QboTokens;
}

/** The operator CLI's token file: QBO_TOKEN_FILE, which must be set explicitly. */
export function tokenFileFromEnv(): string {
  const path = process.env.QBO_TOKEN_FILE;
  if (!path) throw new Error("QBO_TOKEN_FILE must be set to the token file path");
  return path;
}

/** Access token from QBO_ACCESS_TOKEN, e.g. pasted from the sandbox OAuth playground. */
export function envAccessTokenSource(): AccessTokenSource {
  return {
    async current() {
      const token = process.env.QBO_ACCESS_TOKEN;
      if (!token) throw new Error("QBO_ACCESS_TOKEN is not set");
      return token;
    },
  };
}

/**
 * Access token from a consent token file, refreshed and re-saved when expired.
 * The refresh token rotates on every refresh, so the file must be written back.
 */
export function fileAccessTokenSource(path: string): AccessTokenSource {
  return {
    async current() {
      let tokens = loadTokens(path);
      if (!tokens) throw new Error(`No QBO tokens at ${path}; run \`npm run consent -w @inventory/quickbooks\` first`);
      if (isExpired(tokens)) {
        tokens = await refreshTokens(oauthConfigFromEnv(), tokens);
        saveTokens(path, tokens);
      }
      return tokens.accessToken;
    },
  };
}
