/**
 * Store identity resolution (store.ts): the API → identity field mapping (the
 * numeric id always derives from the gid — the Shop type has no legacyResourceId
 * field, which the live API taught us the hard way), the registry upsert, and the
 * non-fatal warning when a configured STORE_ID disagrees with the live store.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("@checkin/s-ingest-core", () => ({
  // faithful-enough stand-in: last numeric path segment of the gid
  legacyIdFromGid: vi.fn((gid: string) => /\/(\d+)(?:\?.*)?$/.exec(gid)?.[1]),
  logger: { info: vi.fn(), warn, error: vi.fn() },
}));

import { resolveStoreIdentity, ensureStore } from "../../src/sync/store.js";
import { legacyIdFromGid } from "@checkin/s-ingest-core";
import { fakeClient } from "../helpers/fakeClient.js";
import { fakePrisma } from "../helpers/fakePrisma.js";

const shopResp = (shop: Record<string, unknown>) => ({ shop });

beforeEach(() => vi.clearAllMocks());

describe("resolveStoreIdentity", () => {
  it("maps the API shop onto the canonical identity (storeId = myshopifyDomain, numericId from the gid)", async () => {
    const client = fakeClient(
      shopResp({ id: "gid://shopify/Shop/123", myshopifyDomain: "acme.myshopify.com", name: "Acme" }),
    );
    const id = await resolveStoreIdentity(client);

    expect(id).toEqual({ storeId: "acme.myshopify.com", shopGid: "gid://shopify/Shop/123", numericId: "123", name: "Acme" });
    expect(legacyIdFromGid).toHaveBeenCalledWith("gid://shopify/Shop/123");
  });

  it("maps an absent name to null", async () => {
    const client = fakeClient(shopResp({ id: "gid://shopify/Shop/777", myshopifyDomain: "x.myshopify.com" }));
    const id = await resolveStoreIdentity(client);

    expect(id.numericId).toBe("777");
    expect(id.name).toBeNull();
  });

  it("falls back to an empty numericId when the gid has no numeric segment", async () => {
    const client = fakeClient(shopResp({ id: "gid://shopify/Shop/abc", myshopifyDomain: "x.myshopify.com" }));
    const id = await resolveStoreIdentity(client);
    expect(id.numericId).toBe("");
  });
});

describe("ensureStore", () => {
  const client = fakeClient(
    shopResp({ id: "gid://shopify/Shop/123", myshopifyDomain: "acme.myshopify.com", name: "Acme" }),
  );

  it("upserts the registry row keyed on myshopifyDomain and returns the identity", async () => {
    const prisma = fakePrisma();
    const id = await ensureStore(prisma as never, client, "acme.myshopify.com");

    expect(id.storeId).toBe("acme.myshopify.com");
    expect(prisma.store.upsert).toHaveBeenCalledWith({
      where: { myshopifyDomain: "acme.myshopify.com" },
      create: { myshopifyDomain: "acme.myshopify.com", shopGid: "gid://shopify/Shop/123", numericId: "123", name: "Acme" },
      update: { shopGid: "gid://shopify/Shop/123", numericId: "123", name: "Acme" },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns (non-fatally) when the configured STORE_ID disagrees with the live store", async () => {
    const prisma = fakePrisma();
    await ensureStore(prisma as never, client, "stale.myshopify.com");

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("does not match"), {
      configured: "stale.myshopify.com",
      resolved: "acme.myshopify.com",
    });
    expect(prisma.store.upsert).toHaveBeenCalled(); // still upserts the live identity
  });

  it("does not warn when no STORE_ID is configured", async () => {
    await ensureStore(fakePrisma() as never, client, undefined);
    expect(warn).not.toHaveBeenCalled();
  });
});
