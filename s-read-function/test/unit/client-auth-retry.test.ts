/**
 * Integration between the request loop (client.ts) and token acquisition (token.ts): a
 * warm Lambda can hold a token that's since expired or been rotated, so a 401 mid-run must
 * invalidate the cache, re-mint once, and retry the same request — not fail outright, and
 * not loop forever on a persistently-bad credential.
 *
 * client-request.test.ts covers the retry/throttle loop with a static adminToken (which
 * never mints, so it never exercises this path); shopify-token.test.ts covers minting in
 * isolation. This file is the seam between the two.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createShopifyClient, REQUEST_TIMEOUT_MS } from "../../src/shopify/client.js";
import { resetShopifyTokenCache } from "../../src/shopify/token.js";
import type { ShopifyConfig } from "@checkin/s-ingest-core";

vi.mock("@checkin/s-ingest-core", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const cfg = {
  shop: "shop.myshopify.com",
  endpoint: "https://shop.myshopify.com/admin/api/2026-04/graphql.json",
  clientId: "cid",
  clientSecret: "csecret",
} as ShopifyConfig;

const TOKEN_URL = "https://shop.myshopify.com/admin/oauth/access_token";

function tokenResp(accessToken: string) {
  return { ok: true, status: 200, json: async () => ({ access_token: accessToken }), text: async () => "" } as unknown as Response;
}
function graphqlResp(opts: { status?: number; data?: unknown; text?: string }) {
  const status = opts.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => ({ data: opts.data }),
    text: async () => opts.text ?? "",
  } as unknown as Response;
}

beforeEach(() => {
  resetShopifyTokenCache();
  // Fire backoff-sleep timers synchronously but leave the per-attempt abort timer pending
  // (same convention as client-request.test.ts) — firing it would abort every mocked fetch.
  vi.stubGlobal(
    "setTimeout",
    ((cb: () => void, ms: number) => {
      if (ms === REQUEST_TIMEOUT_MS) return 0 as unknown as ReturnType<typeof setTimeout>;
      cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createShopifyClient.request — 401 invalidate-and-retry", () => {
  it("mints a token, invalidates and re-mints once on a 401, then succeeds on retry", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === TOKEN_URL) {
        const call = fetchMock.mock.calls.filter((c) => c[0] === TOKEN_URL).length;
        return Promise.resolve(tokenResp(call === 1 ? "shpat_stale" : "shpat_fresh"));
      }
      const graphqlCall = fetchMock.mock.calls.filter((c) => c[0] === cfg.endpoint).length;
      return Promise.resolve(graphqlCall === 1 ? graphqlResp({ status: 401 }) : graphqlResp({ data: { ok: true } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const data = await createShopifyClient(cfg).request<{ ok: boolean }>("query {}");

    expect(data).toEqual({ ok: true });
    const tokenCalls = fetchMock.mock.calls.filter((c) => c[0] === TOKEN_URL);
    const graphqlCalls = fetchMock.mock.calls.filter((c) => c[0] === cfg.endpoint);
    expect(tokenCalls).toHaveLength(2); // initial mint + one re-mint after the 401
    expect(graphqlCalls).toHaveLength(2); // rejected once, retried once
    // The retried request carries the freshly-minted token, not the stale one.
    expect((graphqlCalls[1][1] as RequestInit).headers as Record<string, string>).toMatchObject({
      "X-Shopify-Access-Token": "shpat_fresh",
    });
  });

  it("does not loop forever: a second consecutive 401 fails the request", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === TOKEN_URL) return Promise.resolve(tokenResp("shpat_always_stale"));
      return Promise.resolve(graphqlResp({ status: 401, text: "invalid token" }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createShopifyClient(cfg).request("query {}")).rejects.toThrow("HTTP 401");

    const graphqlCalls = fetchMock.mock.calls.filter((c) => c[0] === cfg.endpoint);
    expect(graphqlCalls).toHaveLength(2); // one original attempt + exactly one retry, then give up
  });

  it("does not mint a token at all when a static adminToken is configured", async () => {
    const staticCfg = { ...cfg, adminToken: "shpat_static", clientId: undefined, clientSecret: undefined } as ShopifyConfig;
    const fetchMock = vi.fn((url: string) => {
      if (url === TOKEN_URL) throw new Error("should not mint when a static token is set");
      return Promise.resolve(graphqlResp({ data: { ok: true } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const data = await createShopifyClient(staticCfg).request<{ ok: boolean }>("query {}");

    expect(data).toEqual({ ok: true });
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).headers as Record<string, string>).toMatchObject({ "X-Shopify-Access-Token": "shpat_static" });
  });
});
