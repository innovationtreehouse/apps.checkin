import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { CredentialStore, StoredCredentials } from "./refresher";

const STRING_FIELDS = ["clientId", "clientSecret", "accessToken", "refreshToken", "realmId"] as const;
const NUMBER_FIELDS = ["obtainedAt", "expiresIn"] as const;

export function parseCredentials(raw: string): StoredCredentials {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null) throw new Error("QBO secret is not a JSON object");
  const obj = value as Record<string, unknown>;
  for (const f of STRING_FIELDS) {
    if (typeof obj[f] !== "string" || obj[f] === "") throw new Error(`QBO secret field ${f} must be a non-empty string`);
  }
  for (const f of NUMBER_FIELDS) {
    if (typeof obj[f] !== "number") throw new Error(`QBO secret field ${f} must be a number`);
  }
  return obj as unknown as StoredCredentials;
}

export function secretsManagerStore(secretId: string, client = new SecretsManagerClient({})): CredentialStore {
  return {
    async load() {
      const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      if (!out.SecretString) throw new Error("QBO secret has no SecretString");
      return parseCredentials(out.SecretString);
    },
    async save(creds) {
      await client.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: JSON.stringify(creds) }));
    },
  };
}
