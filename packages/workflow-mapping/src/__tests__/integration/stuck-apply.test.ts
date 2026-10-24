/**
 * The cron sweep for receipts left `applying` with no live push.
 */
import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import {
  APPLY_CLAIM_TTL_MS,
  MAX_SWEEP_APPLY_ATTEMPTS,
  STUCK_APPLY_SWEEP_CAP,
  sweepStuckApplying,
} from "../../lib/apply-receipt";
import { receiptService } from "../../services/receiptService";
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

    expect(await sweepStuckApplying()).toEqual({ resolved: 1, failed: 0, applying: 0, skipped: 0, errored: 0, gaveUp: 0 });

    expect(sinks.calls.inventory).toHaveLength(1);
    expect(sinks.calls.expense).toHaveLength(1);
    expect(await stateOf(r.id)).toBe("resolved");
  });

  it("leaves a receipt with a fresh lease alone", async () => {
    const r = await makeReceipt({ state: "applying" });
    await makeLineStatus(r.id, { recognitionStatus: "recognized", assignedGtin13: "0000000000017" });
    await claim(r.id, new Date());

    expect(await sweepStuckApplying()).toEqual({ resolved: 0, failed: 0, applying: 0, skipped: 0, errored: 0, gaveUp: 0 });

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

describeDb("sweepStuckApplying attempt cap", () => {
  // Fails the database writes `when` matches, by trigger, until restored.
  async function failWrites(sql: { table: string; when: string; message: string }) {
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_write() RETURNS trigger AS $$
      BEGIN
        IF ${sql.when} THEN RAISE EXCEPTION '${sql.message}'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER test_fail_write BEFORE INSERT OR UPDATE ON ${sql.table}
      FOR EACH ROW EXECUTE FUNCTION test_fail_write()`);
  }
  async function restoreWrites(table: string) {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_fail_write ON ${table}`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_fail_write()`);
  }
  // The push throws before it settles: its apply-started audit row is refused.
  const failPushStart = (id: number) =>
    failWrites({
      table: "workflow_audit_log",
      when: `NEW.received_receipt_id = ${id} AND NEW.event_type = 'receipt_apply_started'`,
      message: "audit write refused",
    });
  // Inventory takes the delta but its stamp is lost, so the push returns applying.
  const failInventoryStamp = (id: number) =>
    failWrites({
      table: "received_receipts",
      when: `TG_OP = 'UPDATE' AND NEW.id = ${id} AND NEW.inventory_applied_at IS NOT NULL AND OLD.inventory_applied_at IS NULL`,
      message: "inventory stamp lost",
    });

  const row = (id: number) => db.receivedReceipt.findUniqueOrThrow({ where: { id } });
  const stuckReceipt = async () => {
    const r = await makeReceipt({ state: "applying" });
    await makeLineStatus(r.id, { recognitionStatus: "recognized", assignedGtin13: "0000000000017" });
    return r;
  };

  it("moves a receipt whose push keeps throwing to apply_failed at the cap", async () => {
    const r = await stuckReceipt();
    await failPushStart(r.id);
    try {
      for (let i = 1; i < MAX_SWEEP_APPLY_ATTEMPTS; i++) {
        expect(await sweepStuckApplying()).toMatchObject({ errored: 1, gaveUp: 0 });
        expect(await row(r.id)).toMatchObject({ state: "applying", applySweepAttempts: i });
      }
      expect(await sweepStuckApplying()).toMatchObject({ errored: 1, gaveUp: 1 });
    } finally {
      await restoreWrites("workflow_audit_log");
    }

    const settled = await row(r.id);
    expect(settled).toMatchObject({ state: "apply_failed", applySweepAttempts: 0 });
    expect(settled.validationNotes).toMatch(/Stopped retrying after 3 attempts\. Last error: .*audit write refused/);
    const gaveUp = await db.workflowAuditLog.findMany({
      where: { receivedReceiptId: r.id, eventType: "receipt_apply_failed", toState: "apply_failed" },
    });
    expect(gaveUp).toHaveLength(1);
    expect(JSON.parse(gaveUp[0].details ?? "{}")).toMatchObject({ gaveUp: true, sweepAttempts: MAX_SWEEP_APPLY_ATTEMPTS });
  });

  it("moves a receipt whose inventory stamp keeps failing to apply_failed at the cap", async () => {
    const r = await stuckReceipt();
    await failInventoryStamp(r.id);
    try {
      for (let i = 1; i < MAX_SWEEP_APPLY_ATTEMPTS; i++) {
        expect(await sweepStuckApplying()).toMatchObject({ applying: 1, gaveUp: 0 });
      }
      expect(await sweepStuckApplying()).toMatchObject({ applying: 1, gaveUp: 1 });
    } finally {
      await restoreWrites("received_receipts");
    }

    const settled = await row(r.id);
    expect(settled).toMatchObject({ state: "apply_failed", inventoryAppliedAt: null, applySweepAttempts: 0 });
    expect(settled.validationNotes).toMatch(/Last error: .*inventory stamp lost/);
    expect(await sweepStuckApplying()).toMatchObject({ applying: 0, gaveUp: 0 });
  });

  it("does not count a sweep that finds a live claim", async () => {
    const r = await stuckReceipt();
    await db.receivedReceipt.update({ where: { id: r.id }, data: { applySweepAttempts: MAX_SWEEP_APPLY_ATTEMPTS - 1 } });
    await claim(r.id, new Date());

    for (let i = 0; i < MAX_SWEEP_APPLY_ATTEMPTS; i++) await sweepStuckApplying();

    expect(await row(r.id)).toMatchObject({ state: "applying", applySweepAttempts: MAX_SWEEP_APPLY_ATTEMPTS - 1 });
  });

  it("resets the count when a push succeeds", async () => {
    const r = await stuckReceipt();
    await db.receivedReceipt.update({ where: { id: r.id }, data: { applySweepAttempts: MAX_SWEEP_APPLY_ATTEMPTS - 1 } });

    expect((await sweepStuckApplying()).resolved).toBe(1);

    expect(await row(r.id)).toMatchObject({ state: "resolved", applySweepAttempts: 0 });
  });

  it("resets the count on a manual Retry", async () => {
    const r = await stuckReceipt();
    await db.receivedReceipt.update({ where: { id: r.id }, data: { applySweepAttempts: MAX_SWEEP_APPLY_ATTEMPTS - 1 } });

    expect(await receiptService.retryApply(r.id)).toEqual({ state: "applying" });

    expect((await row(r.id)).applySweepAttempts).toBe(0);
  });
});
