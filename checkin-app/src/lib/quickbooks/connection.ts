/**
 * checkin's one QuickBooks connection, shared by every library that reads or
 * writes the ledger. The app never refreshes or stores tokens: an external
 * refresher owns rotation and publishes the current access token.
 */
import { envAccessTokenSource, type AccessTokenSource, type QboRealm } from "@inventory/quickbooks";
import { config } from "@/lib/config";

/** Reads the published access token from Secrets Manager on every call. */
function secretsManagerTokenSource(secretId: string): AccessTokenSource {
  return {
    async current() {
      const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
      const client = new SecretsManagerClient({ region: config.awsRegion() });
      const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      if (!SecretString) throw new Error("QuickBooks access-token secret is empty");
      return accessTokenFrom(SecretString);
    },
  };
}

/** The secret holds either the bare token or JSON with an `accessToken` field. */
export function accessTokenFrom(secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  const parsed: unknown = JSON.parse(trimmed);
  const token = (parsed as { accessToken?: unknown }).accessToken;
  if (typeof token !== "string" || !token) throw new Error("QuickBooks access-token secret has no accessToken");
  return token;
}

let tokens: AccessTokenSource | undefined;

/**
 * The one token source: Secrets Manager when QBO_ACCESS_TOKEN_SECRET_ID is set
 * (deployed), else QBO_ACCESS_TOKEN (local). With neither, every read throws,
 * so QuickBooks reads fail closed.
 */
export function qboAccessTokenSource(): AccessTokenSource {
  const secretId = process.env.QBO_ACCESS_TOKEN_SECRET_ID;
  tokens ??= secretId ? secretsManagerTokenSource(secretId) : envAccessTokenSource();
  return tokens;
}

/**
 * The company to talk to: production only when CHECKIN_ENV=prod, the sandbox
 * everywhere else. Null when QBO_REALM_ID is unset.
 */
export function qboRealm(): QboRealm | null {
  const realmId = process.env.QBO_REALM_ID;
  if (!realmId) return null;
  return { env: process.env.CHECKIN_ENV === "prod" ? "production" : "sandbox", realmId };
}
