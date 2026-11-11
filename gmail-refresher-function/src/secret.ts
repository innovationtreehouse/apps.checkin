import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { OauthClient } from "./oauth";
import type { CredentialStore, StoredGrant } from "./refresher";

function parseStrings<K extends string>(raw: string, label: string, fields: readonly K[]): Record<K, string> {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null) throw new Error(`${label} secret is not a JSON object`);
  const obj = value as Record<string, unknown>;
  for (const f of fields) {
    if (typeof obj[f] !== "string" || obj[f] === "") throw new Error(`${label} secret field ${f} must be a non-empty string`);
  }
  return obj as Record<K, string>;
}

export function parseClient(raw: string): OauthClient {
  return parseStrings(raw, "Gmail client", ["clientId", "clientSecret"]);
}

export function parseGrant(raw: string): StoredGrant {
  return parseStrings(raw, "Gmail token", ["refreshToken", "mailbox"]);
}

export function secretsManagerStore(clientSecretId: string, tokenSecretId: string, client = new SecretsManagerClient({})): CredentialStore {
  async function read(secretId: string): Promise<string> {
    const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (!out.SecretString) throw new Error("Gmail secret has no SecretString");
    return out.SecretString;
  }
  return {
    loadClient: async () => parseClient(await read(clientSecretId)),
    loadGrant: async () => parseGrant(await read(tokenSecretId)),
  };
}
