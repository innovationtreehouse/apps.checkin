/**
 * Integration tests for the append-only raw log (real Postgres) — the system of record for
 * replay. The locks.test suite covers the GENERIC advisory-lock helper; this covers the
 * append's OWN guarantees: skip a byte-identical re-read of the latest event, append on ANY
 * difference (including a revert to an earlier payload), and never double-append two
 * concurrent writes of the same gid. Skipped unless SHOPIFY_READ_DATABASE_URL is set.
 */
import { it, expect, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { prisma } from "../../src/db/client.js";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { appendRawEvent } from "../../src/ingest/rawLog.js";
import { EventSource, ObjectType } from "../../src/generated/prisma/client.js";
import { describeDb } from "../helpers/db.js";

const STORE = "rawlog-test.myshopify.com";
const GID = "gid://shopify/Order/6001";

function singleConnClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.SHOPIFY_READ_DATABASE_URL as string, max: 1 });
  return new PrismaClient({ adapter });
}

const node = (status: string) => ({
  id: GID,
  legacyResourceId: "6001",
  name: "#6001",
  updatedAt: "2026-02-01T10:00:00Z",
  displayFinancialStatus: status,
  currentTotalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
});

const countEvents = () => prisma.shopifyRawEvent.count({ where: { storeId: STORE, shopifyGid: GID } });
const args = (n: unknown, source: EventSource = EventSource.HAND_LOADED) => ({
  storeId: STORE,
  objectType: ObjectType.ORDER,
  node: n,
  source,
});

describeDb("appendRawEvent", () => {
  beforeEach(async () => {
    await prisma.shopifyRawEvent.deleteMany({ where: { storeId: STORE } });
  });
  afterAll(async () => {
    await prisma.shopifyRawEvent.deleteMany({ where: { storeId: STORE } });
    await prisma.$disconnect();
  });

  it("skips a byte-identical re-read of the latest event", async () => {
    const first = await appendRawEvent(prisma, args(node("PAID")));
    const second = await appendRawEvent(prisma, args(node("PAID")));
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.payloadChanged).toBe(false);
    expect(second.rawEventId).toBe(first.rawEventId); // points back at the existing row
    expect(await countEvents()).toBe(1);
  });

  it("skips the store's identical re-read of its own latest event", async () => {
    await appendRawEvent(prisma, args(node("PAID"), EventSource.BACKFILL));
    const reread = await appendRawEvent(prisma, args(node("PAID"), EventSource.INCREMENTAL));
    expect(reread.inserted).toBe(false);
    expect(reread.payloadChanged).toBe(false);
    expect(await countEvents()).toBe(1);
  });

  it("appends the store's identical read of a hand-made latest event", async () => {
    const handMade = await appendRawEvent(prisma, args(node("PAID"), EventSource.HAND_LOADED));
    const store = await appendRawEvent(prisma, args(node("PAID"), EventSource.INCREMENTAL));
    expect(store.inserted).toBe(true);
    expect(store.payloadChanged).toBe(false);
    expect(store.rawEventId).not.toBe(handMade.rawEventId);
    const latest = await prisma.shopifyRawEvent.findFirst({
      where: { storeId: STORE, shopifyGid: GID },
      orderBy: { id: "desc" },
      select: { source: true },
    });
    expect(latest?.source).toBe(EventSource.INCREMENTAL);
    expect(await countEvents()).toBe(2);
  });

  it("skips a hand-made identical re-load of a hand-made latest event", async () => {
    await appendRawEvent(prisma, args(node("PAID"), EventSource.HAND_LOADED));
    const reload = await appendRawEvent(prisma, args(node("PAID"), EventSource.TEST_LOADED));
    expect(reload.inserted).toBe(false);
    expect(reload.payloadChanged).toBe(false);
    expect(await countEvents()).toBe(1);
  });

  it("appends when the payload differs from the latest", async () => {
    await appendRawEvent(prisma, args(node("PAID")));
    const changed = await appendRawEvent(prisma, args(node("REFUNDED")));
    expect(changed.inserted).toBe(true);
    expect(changed.payloadChanged).toBe(true);
    expect(await countEvents()).toBe(2);
  });

  it("appends a REVERT to an earlier payload (only 'identical to LATEST' is skipped)", async () => {
    await appendRawEvent(prisma, args(node("PAID"))); // v1
    await appendRawEvent(prisma, args(node("REFUNDED"))); // v2 (latest)
    const revert = await appendRawEvent(prisma, args(node("PAID"))); // back to v1 — differs from v2
    expect(revert.inserted).toBe(true);
    expect(revert.payloadChanged).toBe(true);
    expect(await countEvents()).toBe(3);
  });

  it("never double-appends two concurrent writes of the same gid+payload", async () => {
    // Two distinct DB sessions race to append the SAME payload. The per-gid advisory xact
    // lock serializes them, so exactly one inserts and the other dedupes — one row, not two.
    const a = singleConnClient();
    const b = singleConnClient();
    try {
      const [r1, r2] = await Promise.all([appendRawEvent(a, args(node("PAID"))), appendRawEvent(b, args(node("PAID")))]);
      expect([r1.inserted, r2.inserted].filter(Boolean)).toHaveLength(1); // exactly one insert
      expect([r1.payloadChanged, r2.payloadChanged].filter(Boolean)).toHaveLength(1);
      expect(await countEvents()).toBe(1);
    } finally {
      await a.$disconnect();
      await b.$disconnect();
    }
  });
});
