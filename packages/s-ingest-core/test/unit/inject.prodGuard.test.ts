/**
 * Which inject modes each copy accepts. A non-production copy takes HAND_LOADED, TEST_LOADED
 * and historic loads. The production copy, by target store or by its registry row in this
 * database, takes only a historic load whose every record is dated before the cutover.
 * Projection is mocked, so these run without a database.
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

// One payout issued 2026-02-05T00:00:00Z and two balance transactions dated before it.
const fixture = fileURLToPath(new URL("../fixtures/payout-with-refund.json", import.meta.url));
const LATEST_RECORD = new Date("2026-02-05T00:00:00Z");
const AFTER_ALL = new Date("2026-03-01T00:00:00Z");
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

/** Each way a database counts as the production copy. */
const productionCopies = [
  ["the target store is the production store", PROD_STORE_DOMAIN, []],
  ["this database's store registry holds the production store", DEV_STORE, [DEV_STORE, PROD_STORE_DOMAIN]],
] as const;

const singleModes = [
  ["HAND_LOADED", false, EventSource.HAND_LOADED],
  ["TEST_LOADED", true, EventSource.TEST_LOADED],
] as const;

beforeEach(() => {
  vi.mocked(ingestNode).mockClear();
});

describe.each(singleModes)("single %s inject", (_label, test, source) => {
  it("loads into a non-production store", async () => {
    const results = await injectFile(fakePrisma([DEV_STORE]), fixture, { storeId: DEV_STORE, test });

    expect(results).toHaveLength(3);
    expect(vi.mocked(ingestNode)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(ingestNode)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ storeId: DEV_STORE, source }),
    );
  });

  it.each(productionCopies)("is refused when %s", async (_why, storeId, registered) => {
    await expect(injectFile(fakePrisma([...registered]), fixture, { storeId, test })).rejects.toThrow(REFUSAL);
    expect(vi.mocked(ingestNode)).not.toHaveBeenCalled();
  });
});

describe("historic inject", () => {
  it.each(productionCopies)("loads into the production copy, tagged HAND_LOADED, when %s", async (_why, storeId, registered) => {
    const results = await injectFile(fakePrisma([...registered]), fixture, { storeId, historicCutover: AFTER_ALL });

    expect(results).toHaveLength(3);
    expect(vi.mocked(ingestNode)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ storeId, source: EventSource.HAND_LOADED }),
    );
  });

  it("loads into a non-production store", async () => {
    const results = await injectFile(fakePrisma([DEV_STORE]), fixture, { storeId: DEV_STORE, historicCutover: AFTER_ALL });
    expect(results).toHaveLength(3);
  });

  it("refuses the whole file when one record is dated on the cutover", async () => {
    await expect(
      injectFile(fakePrisma([]), fixture, { storeId: PROD_STORE_DOMAIN, historicCutover: LATEST_RECORD }),
    ).rejects.toThrow(/1 GID\(s\) are not dated before the cutover .*ShopifyPaymentsPayout\/5001/);
    expect(vi.mocked(ingestNode)).not.toHaveBeenCalled();
  });

  it("refuses the whole file when records are dated after the cutover", async () => {
    await expect(
      injectFile(fakePrisma([]), fixture, { storeId: PROD_STORE_DOMAIN, historicCutover: new Date("2026-02-02T00:00:00Z") }),
    ).rejects.toThrow(/2 GID\(s\) are not dated before the cutover/);
    expect(vi.mocked(ingestNode)).not.toHaveBeenCalled();
  });

  it("cannot also be a test load", async () => {
    await expect(
      injectFile(fakePrisma([DEV_STORE]), fixture, { storeId: DEV_STORE, test: true, historicCutover: AFTER_ALL }),
    ).rejects.toThrow(/historic load cannot also be a test load/);
    expect(vi.mocked(ingestNode)).not.toHaveBeenCalled();
  });
});
