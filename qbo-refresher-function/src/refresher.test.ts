import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INVALID_GRANT_MARKER, REFRESH_MARGIN_MS, run, type CredentialStore, type StoredCredentials } from "./refresher";

const NOW = 1_800_000_000_000;
const DEV_ID = "dev-client-id";
const SANDBOX = { QBO_ENVIRONMENT: "sandbox", QBO_DEV_CLIENT_ID: DEV_ID };
const PROD = { QBO_ENVIRONMENT: "production", QBO_DEV_CLIENT_ID: DEV_ID };

function creds(over: Partial<StoredCredentials> = {}): StoredCredentials {
  return {
    clientId: DEV_ID,
    clientSecret: "test-secret",
    accessToken: "old-access",
    refreshToken: "old-refresh",
    obtainedAt: NOW - 30 * 60_000,
    expiresIn: 3600,
    realmId: "realm-1",
    ...over,
  };
}

function memoryStore(initial: StoredCredentials) {
  const saved: StoredCredentials[] = [];
  const store: CredentialStore = {
    load: async () => initial,
    save: async (c) => { saved.push(c); },
  };
  return { store, saved };
}

const fetchMock = vi.fn<typeof fetch>();

function intuitOk() {
  fetchMock.mockResolvedValue(new Response(
    JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
    { status: 200 },
  ));
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  fetchMock.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("run current", () => {
  it("refreshes a token inside the expiry margin and persists the rotated pair", async () => {
    intuitOk();
    const nearExpiry = creds({ obtainedAt: NOW - 3600_000 + REFRESH_MARGIN_MS - 1000 });
    const { store, saved } = memoryStore(nearExpiry);

    const out = await run({ action: "current" }, store, SANDBOX, NOW);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh", obtainedAt: NOW, clientSecret: "test-secret" });
    expect(out).toEqual({ accessToken: "new-access", expiresAt: NOW + 3600_000, realmId: "realm-1", clientId: DEV_ID });
  });

  it("returns a fresh token without calling Intuit or writing the secret", async () => {
    const fresh = creds();
    const { store, saved } = memoryStore(fresh);

    const out = await run({ action: "current" }, store, SANDBOX, NOW);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
    expect(out.accessToken).toBe("old-access");
    expect(out.expiresAt).toBe(fresh.obtainedAt + 3600_000);
  });

  it("logs the invalid_grant marker once and does not retry or write", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { store, saved } = memoryStore(creds({ obtainedAt: NOW - 3600_000 }));

    await expect(run({ action: "current" }, store, SANDBOX, NOW)).rejects.toThrow(/invalid_grant/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(saved).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain(INVALID_GRANT_MARKER);
  });

  it("rejects an unknown action", async () => {
    const { store } = memoryStore(creds());
    await expect(run({ action: "rotate" }, store, SANDBOX, NOW)).rejects.toThrow(/unknown action/);
  });
});

describe("run keepalive", () => {
  it("refreshes even a fresh token", async () => {
    intuitOk();
    const { store, saved } = memoryStore(creds());

    await run({ action: "keepalive" }, store, SANDBOX, NOW);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(saved[0].refreshToken).toBe("new-refresh");
  });
});

describe("dev client id guard", () => {
  it("outside production refuses any client id but QBO_DEV_CLIENT_ID", async () => {
    const { store } = memoryStore(creds({ clientId: "prod-client-id" }));
    await expect(run({ action: "current" }, store, SANDBOX, NOW)).rejects.toThrow(/QBO_DEV_CLIENT_ID/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("in production refuses QBO_DEV_CLIENT_ID", async () => {
    const { store } = memoryStore(creds({ clientId: DEV_ID, obtainedAt: NOW - 3600_000 }));
    await expect(run({ action: "keepalive" }, store, PROD, NOW)).rejects.toThrow(/development keys/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("in production accepts a non-dev client id", async () => {
    const { store } = memoryStore(creds({ clientId: "prod-client-id" }));
    await expect(run({ action: "current" }, store, PROD, NOW)).resolves.toMatchObject({ clientId: "prod-client-id" });
  });

  it("refuses a missing or unknown QBO_ENVIRONMENT", async () => {
    const { store } = memoryStore(creds());
    await expect(run({ action: "current" }, store, { QBO_DEV_CLIENT_ID: DEV_ID }, NOW)).rejects.toThrow(/QBO_ENVIRONMENT/);
    await expect(run({ action: "current" }, store, { QBO_ENVIRONMENT: "sandbox" }, NOW)).rejects.toThrow(/QBO_DEV_CLIENT_ID must be set/);
  });
});
