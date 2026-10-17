/**
 * Token acquisition (#237): static-token precedence, client-credentials minting, in-memory
 * cache reuse, and the early-refresh boundary. The 401-invalidate-retry integration (which
 * needs the request loop) lives in client-auth-retry.test.ts; this file exercises
 * getShopifyToken/invalidateShopifyToken in isolation against a stubbed global `fetch`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getShopifyToken, invalidateShopifyToken, resetShopifyTokenCache } from "../../src/shopify/token.js";
import type { ShopifyConfig } from "@checkin/s-ingest-core";

const baseCfg = {
  shop: "shop.myshopify.com",
  endpoint: "https://shop.myshopify.com/admin/api/2025-07/graphql.json",
} as ShopifyConfig;

function tokenResp(accessToken: string) {
  return { ok: true, status: 200, json: async () => ({ access_token: accessToken }), text: async () => "" } as unknown as Response;
}

beforeEach(() => {
  resetShopifyTokenCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getShopifyToken — static token precedence", () => {
  it("returns the static adminToken unchanged and never calls fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const token = await getShopifyToken({ ...baseCfg, adminToken: "shpat_static", clientId: "cid", clientSecret: "csecret" });

    expect(token).toBe("shpat_static");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getShopifyToken — client-credentials minting", () => {
  const cfg = { ...baseCfg, clientId: "cid", clientSecret: "csecret" };

  it("mints via the client-credentials grant on first call", async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResp("shpat_minted"));
    vi.stubGlobal("fetch", fetchMock);

    const token = await getShopifyToken(cfg);

    expect(token).toBe("shpat_minted");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://shop.myshopify.com/admin/oauth/access_token");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(init.body as string).get("grant_type")).toBe("client_credentials");
    expect(new URLSearchParams(init.body as string).get("client_id")).toBe("cid");
    expect(new URLSearchParams(init.body as string).get("client_secret")).toBe("csecret");
  });

  it("reuses the cached token on a subsequent call (no re-mint)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResp("shpat_minted"));
    vi.stubGlobal("fetch", fetchMock);

    await getShopifyToken(cfg);
    const second = await getShopifyToken(cfg);

    expect(second).toBe("shpat_minted");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-mints once the cache is within the early-refresh window (~5 min before ~24h expiry)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(tokenResp("shpat_first")).mockResolvedValueOnce(tokenResp("shpat_second"));
    vi.stubGlobal("fetch", fetchMock);
    const now = vi.spyOn(Date, "now");

    now.mockReturnValue(0);
    expect(await getShopifyToken(cfg)).toBe("shpat_first");

    // Still comfortably cached: 1 hour in.
    now.mockReturnValue(60 * 60 * 1000);
    expect(await getShopifyToken(cfg)).toBe("shpat_first");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Inside the 5-minute-early refresh buffer: 23h56m in.
    now.mockReturnValue(23 * 60 * 60 * 1000 + 56 * 60 * 1000);
    expect(await getShopifyToken(cfg)).toBe("shpat_second");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws a clear error when the token endpoint rejects the exchange", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "invalid_client" } as unknown as Response));

    await expect(getShopifyToken(cfg)).rejects.toThrow(/Shopify token exchange failed: HTTP 401/);
  });

  it("throws when neither a static token nor client-credentials are configured", async () => {
    await expect(getShopifyToken(baseCfg)).rejects.toThrow(/No Shopify credentials configured/);
  });
});

describe("invalidateShopifyToken", () => {
  it("drops the cache so the next call re-mints", async () => {
    const cfg = { ...baseCfg, clientId: "cid", clientSecret: "csecret" };
    const fetchMock = vi.fn().mockResolvedValueOnce(tokenResp("shpat_first")).mockResolvedValueOnce(tokenResp("shpat_second"));
    vi.stubGlobal("fetch", fetchMock);

    expect(await getShopifyToken(cfg)).toBe("shpat_first");
    invalidateShopifyToken();
    expect(await getShopifyToken(cfg)).toBe("shpat_second");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
