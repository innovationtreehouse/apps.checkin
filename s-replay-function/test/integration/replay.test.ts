/**
 * Integration tests against a real Postgres. Skipped unless SHOPIFY_READ_DATABASE_URL is set.
 *   SHOPIFY_READ_DATABASE_URL=postgresql://... npm test
 *
 * (The DB-availability guard in db-availability.test.ts fails CI loudly if this
 * coverage is silently skipped.)
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, injectFixtures, setWatermark, ObjectType } from "@inventory/s-ingest-core";
import { replay, resetWatermark } from "../../src/replay.js";
import { handler } from "../../src/handler.js";
import { wipeStore, orderNode, rawOrderEvent } from "./helpers.js";

const STORE = "replay-test.myshopify.com";
const run = process.env.SHOPIFY_READ_DATABASE_URL ? describe : describe.skip;

const orderGid = (n: number | string) => `gid://shopify/Order/${n}`;
const liveOrder = (gid: string) =>
  prisma.shopOrder.findUnique({ where: { storeId_shopifyGid: { storeId: STORE, shopifyGid: gid } } });
const orderCount = () => prisma.shopOrder.count({ where: { storeId: STORE } });
const latestAdminRun = () =>
  prisma.syncRun.findFirst({ where: { storeId: STORE, kind: "ADMIN" }, orderBy: { id: "desc" } });

run("s-replay-function admin operations", () => {
  beforeEach(() => wipeStore(prisma, STORE));
  afterAll(async () => {
    await wipeStore(prisma, STORE);
    await prisma.$disconnect();
  });

  it("replay re-projects from the raw log (repairs live-table divergence)", async () => {
    // Seed: inject creates a raw event + the live row.
    await injectFixtures(prisma, [{ objectType: ObjectType.ORDER, node: orderNode(orderGid(9001)) }], {
      storeId: STORE,
      test: true,
    });
    expect(await orderCount()).toBe(1);

    // Simulate divergence: the live row is gone but the raw log still has it.
    await prisma.shopOrder.deleteMany({ where: { storeId: STORE } });
    expect(await orderCount()).toBe(0);

    const result = await replay(prisma, {
      storeId: STORE,
      objectType: ObjectType.ORDER,
      actor: "test",
      reason: "integration test",
    });
    expect(result.processed).toBe(1);
    expect(result.distinctGids).toBe(1);
    expect(await orderCount()).toBe(1); // restored from the log
    // The restored row carries the raw event's provenance, not a default.
    expect((await liveOrder(orderGid(9001)))?.source).toBe("TEST_LOADED");

    const adminRuns = await prisma.syncRun.count({ where: { storeId: STORE, kind: "ADMIN" } });
    expect(adminRuns).toBeGreaterThanOrEqual(1);
  });

  it("replays newest-wins: the LAST raw event for a gid is the final live state", async () => {
    const gid = orderGid(5001);
    // Sequential creates guarantee ascending id order — replay streams in id ASC.
    await prisma.shopifyRawEvent.create({
      data: rawOrderEvent(STORE, gid, orderNode(gid, { name: "#first" }), { hash: "h1" }),
    });
    await prisma.shopifyRawEvent.create({
      data: rawOrderEvent(STORE, gid, orderNode(gid, { name: "#second" }), { hash: "h2" }),
    });

    const result = await replay(prisma, { storeId: STORE, actor: "test", reason: "newest-wins" });
    expect(result.processed).toBe(2);
    expect(result.distinctGids).toBe(1);
    expect((await liveOrder(gid))?.name).toBe("#second");
  });

  it("records partial progress on the FAILED run when projection dies mid-stream", async () => {
    // Row 1 is valid; row 2 (created after → higher id, processed second) has no `id` so the
    // order schema parse throws. Row 1 is already committed when row 2 fails.
    const goodGid = orderGid(7001);
    await prisma.shopifyRawEvent.create({ data: rawOrderEvent(STORE, goodGid, orderNode(goodGid)) });
    await prisma.shopifyRawEvent.create({
      data: rawOrderEvent(STORE, orderGid(7002), { name: "#missing-id" } as Record<string, unknown>, { hash: "bad" }),
    });

    await expect(
      replay(prisma, { storeId: STORE, objectType: ObjectType.ORDER, actor: "test", reason: "partial-failure" }),
    ).rejects.toThrow();

    // Row 1 landed despite the later failure (row-by-row commits).
    expect(await liveOrder(goodGid)).not.toBeNull();
    expect(await orderCount()).toBe(1);

    // The FAILED run is honest about how far it got.
    const failed = await latestAdminRun();
    expect(failed?.status).toBe("FAILED");
    expect(failed?.counts).toMatchObject({ processed: 1, distinctGids: 1, failed: true });
    expect((failed?.counts as { lastCommittedId?: string }).lastCommittedId).toBeTruthy();
  });

  it("counts processed events and DISTINCT gids separately (dedup)", async () => {
    // 5 events across 3 gids: A×2, B×2, C×1.
    const events = [
      ["A", "A"],
      ["B", "B"],
      ["C"],
    ].flatMap((names, i) =>
      names.map((suffix, j) =>
        rawOrderEvent(STORE, orderGid(`dedup-${i}`), orderNode(orderGid(`dedup-${i}`), { name: `#${suffix}${j}` }), {
          hash: `h-${i}-${j}`,
        }),
      ),
    );
    for (const data of events) await prisma.shopifyRawEvent.create({ data });

    const result = await replay(prisma, { storeId: STORE, actor: "test", reason: "dedup" });
    expect(result.processed).toBe(5);
    expect(result.distinctGids).toBe(3);
  });

  it("paginates across the 500-row batch boundary (501 events)", async () => {
    const N = 501;
    const data = Array.from({ length: N }, (_, i) => {
      const gid = orderGid(`page-${i}`);
      return rawOrderEvent(STORE, gid, orderNode(gid), { hash: `h-${i}` });
    });
    await prisma.shopifyRawEvent.createMany({ data });

    const result = await replay(prisma, { storeId: STORE, actor: "test", reason: "pagination" });
    expect(result.processed).toBe(N);
    expect(result.distinctGids).toBe(N);
    expect(await orderCount()).toBe(N);
  }, 30_000);

  it("paginates across MULTIPLE full batches (1001 events → three batches, two boundaries)", async () => {
    const N = 1001; // 500 + 500 + 1 — crosses the batch boundary twice, not just once
    const data = Array.from({ length: N }, (_, i) => {
      const gid = orderGid(`multi-${i}`);
      return rawOrderEvent(STORE, gid, orderNode(gid), { hash: `hm-${i}` });
    });
    await prisma.shopifyRawEvent.createMany({ data });

    const result = await replay(prisma, { storeId: STORE, actor: "test", reason: "multi-batch pagination" });
    expect(result.processed).toBe(N);
    expect(result.distinctGids).toBe(N);
    expect(await orderCount()).toBe(N);
  }, 45_000);

  it("dedups a gid repeated across the batch boundary and keeps the newest payload (newest-wins across pages)", async () => {
    const N = 500;
    const data = Array.from({ length: N }, (_, i) => {
      const gid = orderGid(`b-${i}`);
      return rawOrderEvent(STORE, gid, orderNode(gid), { hash: `hb-${i}` });
    });
    await prisma.shopifyRawEvent.createMany({ data }); // ids 1..500 → fill the first batch

    // A second event for the FIRST gid, created last → higher id → lands in the SECOND batch.
    const dupGid = orderGid("b-0");
    await prisma.shopifyRawEvent.create({
      data: rawOrderEvent(STORE, dupGid, orderNode(dupGid, { name: "#newest" }), { hash: "hb-0-again" }),
    });

    const result = await replay(prisma, { storeId: STORE, actor: "test", reason: "dup gid across pages" });
    expect(result.processed).toBe(N + 1); // both occurrences are projected (id ASC stream)
    expect(result.distinctGids).toBe(N); // but the repeated gid is counted once
    // The later (second-batch) payload is projected last, so it is the final live state.
    expect((await liveOrder(dupGid))?.name).toBe("#newest");
  }, 45_000);

  it("over an empty raw log: processed 0, distinctGids 0, one COMPLETED ADMIN run", async () => {
    const result = await replay(prisma, { storeId: STORE, actor: "test", reason: "empty" });
    expect(result.processed).toBe(0);
    expect(result.distinctGids).toBe(0);

    const adminRuns = await prisma.syncRun.findMany({ where: { storeId: STORE, kind: "ADMIN" } });
    expect(adminRuns).toHaveLength(1);
    expect(adminRuns[0].status).toBe("COMPLETED");
  });

  it("on a projection failure: rejects, rolls back the row, and records a FAILED run", async () => {
    // An ORDER payload with no `id` fails orderNodeSchema inside projectNode.
    await prisma.shopifyRawEvent.create({
      data: rawOrderEvent(STORE, orderGid("bad"), {} as Record<string, unknown>, { hash: "h-bad" }),
    });

    await expect(replay(prisma, { storeId: STORE, actor: "test", reason: "bad payload" })).rejects.toThrow();

    // The per-row $transaction rolled back — no live row was written.
    expect(await orderCount()).toBe(0);

    const failed = await latestAdminRun();
    expect(failed?.status).toBe("FAILED");
    expect(failed?.error).toBeTruthy();
  });

  it("filters by gid: only the named order is restored", async () => {
    const a = orderGid("A");
    const b = orderGid("B");
    await prisma.shopifyRawEvent.create({ data: rawOrderEvent(STORE, a, orderNode(a), { hash: "ha" }) });
    await prisma.shopifyRawEvent.create({ data: rawOrderEvent(STORE, b, orderNode(b), { hash: "hb" }) });

    const result = await replay(prisma, { storeId: STORE, gid: a, actor: "test", reason: "gid filter" });
    expect(result.processed).toBe(1);
    expect(await liveOrder(a)).not.toBeNull();
    expect(await liveOrder(b)).toBeNull();
  });

  it("filters by sinceOccurredAt: only events at/after the floor are replayed", async () => {
    const jan = orderGid("jan");
    const mar = orderGid("mar");
    await prisma.shopifyRawEvent.create({
      data: rawOrderEvent(STORE, jan, orderNode(jan), { hash: "hj", occurredAt: new Date("2026-01-01T00:00:00Z") }),
    });
    await prisma.shopifyRawEvent.create({
      data: rawOrderEvent(STORE, mar, orderNode(mar), { hash: "hm", occurredAt: new Date("2026-03-01T00:00:00Z") }),
    });

    const result = await replay(prisma, {
      storeId: STORE,
      sinceOccurredAt: new Date("2026-02-01T00:00:00Z"),
      actor: "test",
      reason: "since filter",
    });
    expect(result.processed).toBe(1);
    expect(await liveOrder(mar)).not.toBeNull();
    expect(await liveOrder(jan)).toBeNull();
  });

  it("is idempotent: running replay twice yields stable state and two ADMIN runs", async () => {
    await injectFixtures(prisma, [{ objectType: ObjectType.ORDER, node: orderNode(orderGid(7777)) }], {
      storeId: STORE,
      test: true,
    });
    await prisma.shopOrder.deleteMany({ where: { storeId: STORE } });

    const first = await replay(prisma, { storeId: STORE, actor: "test", reason: "idempotency 1" });
    const second = await replay(prisma, { storeId: STORE, actor: "test", reason: "idempotency 2" });

    expect(first).toEqual(second);
    expect(await orderCount()).toBe(1);
    expect(await prisma.syncRun.count({ where: { storeId: STORE, kind: "ADMIN" } })).toBe(2);
  });

  it("persists actor + reason on the ADMIN sync_run (audit)", async () => {
    await replay(prisma, { storeId: STORE, actor: "ops:jane", reason: "reproject after refund fix" });

    const audited = await latestAdminRun();
    expect(audited?.actor).toBe("ops:jane");
    expect(audited?.reason).toBe("reproject after refund fix");
    expect(audited?.status).toBe("COMPLETED");
  });

  it("reset-watermark moves the watermark backward / clears it", async () => {
    await setWatermark(prisma, STORE, ObjectType.ORDER, new Date("2026-05-01T00:00:00Z"));

    await resetWatermark(prisma, {
      storeId: STORE,
      objectType: ObjectType.ORDER,
      to: new Date("2026-01-01T00:00:00Z"),
      actor: "test",
      reason: "integration test",
    });
    let state = await prisma.syncState.findUnique({
      where: { storeId_objectType: { storeId: STORE, objectType: "ORDER" } },
    });
    expect(state?.lastUpdatedAtProcessed?.toISOString()).toBe("2026-01-01T00:00:00.000Z");

    await resetWatermark(prisma, { storeId: STORE, objectType: ObjectType.ORDER, to: null, actor: "test", reason: "integration test" });
    state = await prisma.syncState.findUnique({
      where: { storeId_objectType: { storeId: STORE, objectType: "ORDER" } },
    });
    expect(state?.lastUpdatedAtProcessed).toBeNull();
  });

  it("reset-watermark with no objectType clears ALL watermarked types, leaving REFUND untouched", async () => {
    const seeded = new Date("2026-05-01T00:00:00Z");
    for (const t of [ObjectType.ORDER, ObjectType.PAYOUT, ObjectType.BALANCE_TXN, ObjectType.REFUND]) {
      await setWatermark(prisma, STORE, t, seeded);
    }

    const result = await resetWatermark(prisma, { storeId: STORE, actor: "test", reason: "reset all" });
    expect(result.objectTypes).toEqual(["ORDER", "PAYOUT", "BALANCE_TXN"]);
    expect(result.to).toBeNull();

    for (const t of ["ORDER", "PAYOUT", "BALANCE_TXN"] as const) {
      const state = await prisma.syncState.findUnique({ where: { storeId_objectType: { storeId: STORE, objectType: t } } });
      expect(state?.lastUpdatedAtProcessed).toBeNull();
    }
    // REFUND is NOT a watermarked type — it must be left exactly as seeded.
    const refund = await prisma.syncState.findUnique({
      where: { storeId_objectType: { storeId: STORE, objectType: "REFUND" } },
    });
    expect(refund?.lastUpdatedAtProcessed?.toISOString()).toBe(seeded.toISOString());
  });

  // ── Tier 3 e2e: the actual Lambda entry — admin event → real PG side effect + audit ──────
  it("handler (e2e): a replay admin event restores data and records an audited ADMIN run", async () => {
    await injectFixtures(prisma, [{ objectType: ObjectType.ORDER, node: orderNode(orderGid(4242)) }], {
      storeId: STORE,
      test: true,
    });
    await prisma.shopOrder.deleteMany({ where: { storeId: STORE } }); // simulate divergence
    expect(await orderCount()).toBe(0);

    const result = await handler({
      mode: "replay",
      storeId: STORE,
      objectType: "ORDER",
      actor: "ops:e2e",
      reason: "reproject after refund fix",
    });

    expect(result).toMatchObject({ processed: 1, distinctGids: 1 });
    expect(await orderCount()).toBe(1); // restored through the Lambda handler, not a direct call
    const run = await latestAdminRun();
    expect(run).toMatchObject({ actor: "ops:e2e", reason: "reproject after refund fix", status: "COMPLETED" });
  });

  it("handler (e2e): a reset-watermark admin event clears the watermark and audits the run", async () => {
    await setWatermark(prisma, STORE, ObjectType.ORDER, new Date("2026-05-01T00:00:00Z"));

    const result = await handler({
      mode: "reset-watermark",
      storeId: STORE,
      objectType: "ORDER",
      to: null,
      actor: "ops:e2e",
      reason: "force re-pull",
    });

    expect(result).toMatchObject({ objectTypes: ["ORDER"], to: null });
    const state = await prisma.syncState.findUnique({
      where: { storeId_objectType: { storeId: STORE, objectType: "ORDER" } },
    });
    expect(state?.lastUpdatedAtProcessed).toBeNull();
    expect((await latestAdminRun())?.actor).toBe("ops:e2e");
  });

  it("handler (e2e): rejects an event missing the required audit fields before touching the DB", async () => {
    await expect(
      handler({ mode: "replay", storeId: STORE, objectType: "ORDER" }), // no actor/reason
    ).rejects.toThrow();
    expect(await prisma.syncRun.count({ where: { storeId: STORE, kind: "ADMIN" } })).toBe(0);
  });
});
