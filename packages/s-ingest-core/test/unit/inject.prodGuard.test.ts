/**
 * injectFile refuses the production store's copy in both modes: when the target store is
 * the production store, and when this database's store registry holds it. Projection is
 * mocked, so these run without a database.
 */
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "../../src/db/client.js";
import { injectFile } from "../../src/ingest/inject.js";
import { ingestNode } from "../../src/ingest/ingestNode.js";
import { PROD_STORE_DOMAIN } from "../../src/config.js";
import { EventSource } from "../../src/generated/prisma/client.js";

vi.mock("../../src/ingest/ingestNode.js", () => ({
  ingestNode: vi.fn(async (_prisma: unknown, input: { node: { id: string } }) => ({
    rawEventId: 1n,
    shopifyGid: input.node.id,
    occurredAt: null,
    inserted: true,
  })),
}));

const fixture = fileURLToPath(new URL("../fixtures/payout-with-refund.json", import.meta.url));
const DEV_STORE = "dev-store.myshopify.com";
const REFUSAL = "inject refused: hand-loading is not allowed into the production copy";

/** A client whose store registry holds the given domains and which has no API-owned rows. */
function fakePrisma(registered: string[]): PrismaClient {
  const none = vi.fn(async () => []);
  return {
    store: {
      findUnique: vi.fn(async ({ where }: { where: { myshopifyDomain: string } }) =>
        registered.includes(where.myshopifyDomain) ? { myshopifyDomain: where.myshopifyDomain } : null,
      ),
    },
    shopOrder: { findMany: none },
    shopPayout: { findMany: none },
    shopBalanceTransaction: { findMany: none },
    shopRefund: { findMany: none },
  } as unknown as PrismaClient;
}

const modes = [
  ["HAND_LOADED", false, EventSource.HAND_LOADED],
  ["TEST_LOADED", true, EventSource.TEST_LOADED],
] as const;

beforeEach(() => {
  vi.mocked(ingestNode).mockClear();
});

describe.each(modes)("injectFile, %s", (_label, test, source) => {
  it("loads into a non-production store", async () => {
    const results = await injectFile(fakePrisma([DEV_STORE]), fixture, { storeId: DEV_STORE, test });

    expect(results).toHaveLength(3);
    expect(vi.mocked(ingestNode)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(ingestNode)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ storeId: DEV_STORE, source }),
    );
  });

  it("refuses when the target store is the production store", async () => {
    await expect(injectFile(fakePrisma([]), fixture, { storeId: PROD_STORE_DOMAIN, test })).rejects.toThrow(REFUSAL);
    expect(vi.mocked(ingestNode)).not.toHaveBeenCalled();
  });

  it("refuses when this database's store registry holds the production store", async () => {
    const prisma = fakePrisma([DEV_STORE, PROD_STORE_DOMAIN]);

    await expect(injectFile(prisma, fixture, { storeId: DEV_STORE, test })).rejects.toThrow(REFUSAL);
    expect(vi.mocked(ingestNode)).not.toHaveBeenCalled();
  });
});
