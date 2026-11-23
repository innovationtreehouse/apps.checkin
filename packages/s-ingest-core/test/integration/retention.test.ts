/**
 * Integration tests for the reader's retention pass (real Postgres): raw log entries go seven years
 * after their Form 990 deadline unless a replay still needs them, exports go 90 days after their run
 * ended, and each run is capped. Skipped unless SHOPIFY_READ_DATABASE_URL is set.
 */
import { it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../../src/db/client.js";
import {
  EXPORT_CAP,
  RAW_EVENT_CAP,
  RETENTION_ACTOR,
  RETENTION_SCOPE,
  runRetention,
  sweepExports,
  sweepRawEvents,
} from "../../src/sync/retention.js";
import { EventSource, ObjectType, SyncKind, SyncStatus } from "../../src/generated/prisma/client.js";
import { describeDb } from "../helpers/db.js";

const STORE = "retention-test.myshopify.com";
// The 2026 fiscal year (July 2025 – June 2026) is kept through 2033-11-15.
const NOW = new Date("2033-11-16T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

let seq = 0;
const rawEvent = (gid: string, occurredAt: Date | null, fetchedAt = occurredAt ?? new Date("2020-01-01T00:00:00Z")) => ({
  storeId: STORE,
  objectType: ObjectType.ORDER,
  shopifyGid: gid,
  occurredAt,
  fetchedAt,
  source: EventSource.INCREMENTAL,
  payload: { id: gid },
  payloadHash: `h${seq++}`,
});

type RawEventData = Omit<ReturnType<typeof rawEvent>, "objectType"> & { objectType: ObjectType };

async function logEvents(...events: RawEventData[]) {
  const ids: bigint[] = [];
  for (const data of events) ids.push((await prisma.shopifyRawEvent.create({ data, select: { id: true } })).id);
  return ids;
}

const remainingIds = async () =>
  (await prisma.shopifyRawEvent.findMany({ where: { storeId: STORE }, select: { id: true }, orderBy: { id: "asc" } })).map((r) => r.id);

async function capture(fetchedAt: Date, run?: { status: SyncStatus; finishedAt: Date | null }) {
  const syncRunId = run
    ? (await prisma.syncRun.create({
      data: { storeId: STORE, kind: SyncKind.BACKFILL, objectScope: "orders", status: run.status, startedAt: fetchedAt, finishedAt: run.finishedAt },
      select: { id: true },
    })).id
    : null;
  const exp = await prisma.shopifyBulkExport.create({
    data: { storeId: STORE, objectType: ObjectType.ORDER, bulkOperationId: `op${seq++}`, source: EventSource.BACKFILL, syncRunId, recordCount: 1, jsonl: "{}", fetchedAt },
    select: { id: true },
  });
  return exp.id;
}

const exportIds = async () =>
  (await prisma.shopifyBulkExport.findMany({ where: { storeId: STORE }, select: { id: true }, orderBy: { id: "asc" } })).map((r) => r.id);

const daysBefore = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

describeDb("reader retention", () => {
  const clear = async () => {
    await prisma.shopifyRawEvent.deleteMany({ where: { storeId: STORE } });
    await prisma.shopifyBulkExport.deleteMany({ where: { storeId: STORE } });
    await prisma.syncRun.deleteMany({ where: { storeId: STORE } });
  };
  beforeEach(clear);
  afterAll(async () => {
    await clear();
    await prisma.$disconnect();
  });

  it("deletes a superseded entry past retention and keeps one inside it", async () => {
    const [, inside, latest] = await logEvents(
      rawEvent("gid://shopify/Order/1", new Date("2026-06-30T23:59:59Z")),
      rawEvent("gid://shopify/Order/1", new Date("2026-07-01T00:00:00Z")),
      rawEvent("gid://shopify/Order/1", new Date("2027-01-01T00:00:00Z")),
    );
    expect(await sweepRawEvents(prisma, STORE, NOW)).toEqual({ deleted: 1, failed: 0 });
    expect(await remainingIds()).toEqual([inside, latest]);
  });

  it("dates the boundary like a receipt: kept through November 15, due on November 16", async () => {
    await logEvents(
      rawEvent("gid://shopify/Order/2", new Date("2026-03-01T00:00:00Z")),
      rawEvent("gid://shopify/Order/2", new Date("2030-01-01T00:00:00Z")),
    );
    expect(await sweepRawEvents(prisma, STORE, new Date("2033-11-15T23:59:59Z"))).toEqual({ deleted: 0, failed: 0 });
    expect(await sweepRawEvents(prisma, STORE, NOW)).toEqual({ deleted: 1, failed: 0 });
  });

  it("keeps the entry a replay rebuilds the live row from, by log order and by store time", async () => {
    const old = new Date("2019-01-01T00:00:00Z");
    const [only, newestByTime, laterSnapshot, , kept] = await logEvents(
      // The only entry for its gid is the live row's source.
      rawEvent("gid://shopify/Order/3", old),
      // A bulk snapshot logged after a newer incremental read: the incremental stays the newest by time.
      rawEvent("gid://shopify/Order/4", new Date("2019-06-01T00:00:00Z")),
      rawEvent("gid://shopify/Order/4", old),
      // Superseded on both counts, so it goes.
      rawEvent("gid://shopify/Order/5", old),
      rawEvent("gid://shopify/Order/5", new Date("2019-02-01T00:00:00Z")),
    );
    expect(await sweepRawEvents(prisma, STORE, NOW)).toEqual({ deleted: 1, failed: 0 });
    expect(await remainingIds()).toEqual([only, newestByTime, laterSnapshot, kept]);
  });

  it("deletes an older payout or balance transaction entry once a later-logged one exists, with the same store time", async () => {
    const issued = new Date("2019-01-01T00:00:00Z");
    const [, newestPayout, , newestTxn] = await logEvents(
      { ...rawEvent("gid://shopify/ShopifyPaymentsPayout/1", issued), objectType: ObjectType.PAYOUT },
      { ...rawEvent("gid://shopify/ShopifyPaymentsPayout/1", issued), objectType: ObjectType.PAYOUT },
      { ...rawEvent("gid://shopify/ShopifyPaymentsBalanceTransaction/1", issued), objectType: ObjectType.BALANCE_TXN },
      { ...rawEvent("gid://shopify/ShopifyPaymentsBalanceTransaction/1", issued), objectType: ObjectType.BALANCE_TXN },
    );
    expect(await sweepRawEvents(prisma, STORE, NOW)).toEqual({ deleted: 2, failed: 0 });
    expect(await remainingIds()).toEqual([newestPayout, newestTxn]);
  });

  it("keeps the only payout entry for its gid past retention", async () => {
    const [only] = await logEvents(
      { ...rawEvent("gid://shopify/ShopifyPaymentsPayout/2", new Date("2019-01-01T00:00:00Z")), objectType: ObjectType.PAYOUT },
    );
    expect(await sweepRawEvents(prisma, STORE, NOW)).toEqual({ deleted: 0, failed: 0 });
    expect(await remainingIds()).toEqual([only]);
  });

  it("keeps an order entry a later-logged entry with the same store time follows", async () => {
    const updated = new Date("2019-01-01T00:00:00Z");
    const ids = await logEvents(rawEvent("gid://shopify/Order/8", updated), rawEvent("gid://shopify/Order/8", updated));
    expect(await sweepRawEvents(prisma, STORE, NOW)).toEqual({ deleted: 0, failed: 0 });
    expect(await remainingIds()).toEqual(ids);
  });

  it("dates an entry with no store time by its fetch", async () => {
    const [undated] = await logEvents(
      rawEvent("gid://shopify/Order/6", null, new Date("2019-01-01T00:00:00Z")),
      rawEvent("gid://shopify/Order/6", new Date("2019-02-01T00:00:00Z")),
    );
    expect(await sweepRawEvents(prisma, STORE, NOW)).toEqual({ deleted: 1, failed: 0 });
    expect(await remainingIds()).not.toContain(undated);
  });

  it("deletes at most RAW_EVENT_CAP entries per run, oldest first", async () => {
    const old = new Date("2019-01-01T00:00:00Z");
    const rows = Array.from({ length: RAW_EVENT_CAP + 5 }, (_, i) => rawEvent(`gid://shopify/Order/cap${i}`, old));
    await prisma.shopifyRawEvent.createMany({ data: rows });
    await prisma.shopifyRawEvent.createMany({
      data: rows.map((r) => ({ ...r, occurredAt: new Date("2019-02-01T00:00:00Z"), payloadHash: `h${seq++}` })),
    });
    expect(await sweepRawEvents(prisma, STORE, NOW)).toEqual({ deleted: RAW_EVENT_CAP, failed: 0 });
    expect(await sweepRawEvents(prisma, STORE, NOW)).toEqual({ deleted: 5, failed: 0 });
    expect(await prisma.shopifyRawEvent.count({ where: { storeId: STORE } })).toBe(RAW_EVENT_CAP + 5);
  });

  it("deletes an export 91 days after its run ended and keeps one at 89", async () => {
    const kept = await capture(daysBefore(95), { status: SyncStatus.COMPLETED, finishedAt: daysBefore(89) });
    await capture(daysBefore(95), { status: SyncStatus.COMPLETED, finishedAt: daysBefore(91) });
    expect(await sweepExports(prisma, STORE, NOW)).toEqual({ deleted: 1, failed: 0 });
    expect(await exportIds()).toEqual([kept]);
  });

  it("deletes an export whose load failed on the same rule, and dates one with no finished run by its capture", async () => {
    await capture(daysBefore(95), { status: SyncStatus.FAILED, finishedAt: daysBefore(91) });
    await capture(daysBefore(91), { status: SyncStatus.RUNNING, finishedAt: null });
    await capture(daysBefore(91));
    const kept = await capture(daysBefore(89));
    expect(await sweepExports(prisma, STORE, NOW)).toEqual({ deleted: 3, failed: 0 });
    expect(await exportIds()).toEqual([kept]);
  });

  it("deletes at most EXPORT_CAP exports per run", async () => {
    for (let i = 0; i < EXPORT_CAP + 2; i++) await capture(daysBefore(100));
    expect(await sweepExports(prisma, STORE, NOW)).toEqual({ deleted: EXPORT_CAP, failed: 0 });
    expect(await exportIds()).toHaveLength(2);
  });

  it("records each pass as an ADMIN sync_run with its counts", async () => {
    await logEvents(
      rawEvent("gid://shopify/Order/7", new Date("2019-01-01T00:00:00Z")),
      rawEvent("gid://shopify/Order/7", new Date("2019-02-01T00:00:00Z")),
    );
    await capture(daysBefore(100));
    expect(await runRetention(prisma, STORE, NOW)).toEqual({ rawEvents: 1, exports: 1, failed: 0 });
    const run = await prisma.syncRun.findFirst({ where: { storeId: STORE, objectScope: RETENTION_SCOPE } });
    expect(run).toMatchObject({ kind: SyncKind.ADMIN, status: SyncStatus.COMPLETED, actor: RETENTION_ACTOR, counts: { rawEvents: 1, exports: 1, failed: 0 } });
  });
});
