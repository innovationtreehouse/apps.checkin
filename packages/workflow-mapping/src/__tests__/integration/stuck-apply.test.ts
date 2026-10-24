/**
 * The cron sweep for receipts left `applying` with no live push.
 */
import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { APPLY_CLAIM_TTL_MS, STUCK_APPLY_SWEEP_CAP, sweepStuckApplying } from "../../lib/apply-receipt";
import { describeDb } from "../helpers/db";
import { clearAll, configure, makeLineStatus, makeReceipt, recordingSinks } from "../helpers/setup";

let sinks: ReturnType<typeof recordingSinks>;

beforeEach(async () => {
  await clearAll();
  sinks = recordingSinks();
  configure(sinks);
});

const claim = (id: number, applyClaimedAt: Date) => db.receivedReceipt.update({ where: { id }, data: { applyClaimedAt } });
const stateOf = async (id: number) => (await db.receivedReceipt.findUniqueOrThrow({ where: { id } })).state;

describeDb("sweepStuckApplying", () => {
  it("pushes an unclaimed applying receipt and resolves it", async () => {
    const r = await makeReceipt({ state: "applying" });
    await makeLineStatus(r.id, { recognitionStatus: "recognized", assignedGtin13: "0000000000017" });

    expect(await sweepStuckApplying()).toEqual({ resolved: 1, failed: 0, applying: 0, skipped: 0, errored: 0 });

    expect(sinks.calls.inventory).toHaveLength(1);
    expect(sinks.calls.expense).toHaveLength(1);
    expect(await stateOf(r.id)).toBe("resolved");
  });

  it("leaves a receipt with a fresh lease alone", async () => {
    const r = await makeReceipt({ state: "applying" });
    await makeLineStatus(r.id, { recognitionStatus: "recognized", assignedGtin13: "0000000000017" });
    await claim(r.id, new Date());

    expect(await sweepStuckApplying()).toEqual({ resolved: 0, failed: 0, applying: 0, skipped: 0, errored: 0 });

    expect(sinks.calls.inventory).toHaveLength(0);
    expect(await stateOf(r.id)).toBe("applying");
  });

  it("takes over a stale lease and releases it", async () => {
    const r = await makeReceipt({ state: "applying" });
    await makeLineStatus(r.id, { recognitionStatus: "recognized", assignedGtin13: "0000000000017" });
    await claim(r.id, new Date(Date.now() - APPLY_CLAIM_TTL_MS - 1_000));

    expect((await sweepStuckApplying()).resolved).toBe(1);

    const row = await db.receivedReceipt.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.state).toBe("resolved");
    expect(row.applyClaimedAt).toBeNull();
  });

  it("ignores apply_failed receipts", async () => {
    const r = await makeReceipt({ state: "apply_failed" });

    expect((await sweepStuckApplying()).resolved).toBe(0);

    expect(sinks.calls.expense).toHaveLength(0);
    expect(await stateOf(r.id)).toBe("apply_failed");
  });

  it("pushes at most the cap per run, oldest first", async () => {
    const receipts = [];
    for (let i = 0; i <= STUCK_APPLY_SWEEP_CAP; i++) receipts.push(await makeReceipt({ state: "applying" }));

    expect((await sweepStuckApplying()).resolved).toBe(STUCK_APPLY_SWEEP_CAP);

    expect(sinks.calls.expense).toHaveLength(STUCK_APPLY_SWEEP_CAP);
    expect(await stateOf(receipts[0].id)).toBe("resolved");
    expect(await stateOf(receipts[STUCK_APPLY_SWEEP_CAP].id)).toBe("applying");
  });
});
