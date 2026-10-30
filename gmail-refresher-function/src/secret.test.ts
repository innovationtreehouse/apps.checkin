import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { describe, expect, it, vi } from "vitest";
import { parseClient, parseGrant, secretsManagerStore } from "./secret";

function clientAnswering(secrets: Record<string, string | undefined>): SecretsManagerClient {
  const client = new SecretsManagerClient({ region: "us-east-1" });
  vi.spyOn(client, "send").mockImplementation(async (command: unknown) => {
    if (!(command instanceof GetSecretValueCommand)) throw new Error("unexpected command");
    return { SecretString: secrets[command.input.SecretId ?? ""] };
  });
  return client;
}

describe("secretsManagerStore", () => {
  it("reads the client and the grant from their own secrets", async () => {
    const store = secretsManagerStore("client-id", "token-id", clientAnswering({
      "client-id": JSON.stringify({ clientId: "i", clientSecret: "s" }),
      "token-id": JSON.stringify({ refreshToken: "r", mailbox: "m" }),
    }));
    await expect(store.loadClient()).resolves.toEqual({ clientId: "i", clientSecret: "s" });
    await expect(store.loadGrant()).resolves.toEqual({ refreshToken: "r", mailbox: "m" });
  });

  it("throws when a secret has no SecretString", async () => {
    const store = secretsManagerStore("client-id", "token-id", clientAnswering({}));
    await expect(store.loadClient()).rejects.toThrow(/no SecretString/);
    await expect(store.loadGrant()).rejects.toThrow(/no SecretString/);
  });
});

describe("secret parsing", () => {
  it("accepts complete secrets", () => {
    expect(parseClient(JSON.stringify({ clientId: "i", clientSecret: "s" }))).toEqual({ clientId: "i", clientSecret: "s" });
    expect(parseGrant(JSON.stringify({ refreshToken: "r", mailbox: "m" }))).toEqual({ refreshToken: "r", mailbox: "m" });
  });

  it("rejects a secret missing a field, naming the field", () => {
    expect(() => parseGrant(JSON.stringify({ refreshToken: "value-r" }))).toThrow(/mailbox/);
  });

  it("rejects a non-object", () => {
    expect(() => parseClient("null")).toThrow(/JSON object/);
  });
});
