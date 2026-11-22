/** Each change and its WorkflowAuditLog row commit together: a refused audit row leaves the change unmade. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { db } from "../../db";
import type { OrgEventRecord } from "../../contract";
import { tryAutoProceedApply } from "../../lib/auto-proceed";
import { orgEventConsumer } from "../../services/orgEventConsumer";
import { rerunMatching } from "../../services/pendingMatching";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { MANAGER, TEST_ORG_ID, clearAll, configure, makeLineStatus, makeReceipt, recordingSinks } from "../helpers/setup";

const GTIN = "0000000000017";
const PROV = "2000000000015";

/** Makes Postgres refuse rows on `table` matching `condition` (over NEW and OLD), whichever client writes them. */
async function refuse(table: string, condition: string): Promise<void> {
  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION test_refuse_${table}() RETURNS trigger AS $$
    BEGIN
      IF ${condition} THEN RAISE EXCEPTION 'write refused on %', TG_TABLE_NAME; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await db.$executeRawUnsafe(`CREATE TRIGGER test_refuse_write BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION test_refuse_${table}()`);
}

const failAudit = (...eventTypes: string[]) =>
  refuse("workflow_audit_log", `NEW.event_type IN (${eventTypes.map((e) => `'${e}'`).join(", ")})`);

let sinks: ReturnType<typeof recordingSinks>;

beforeEach(async () => {
  await clearAll();
  sinks = recordingSinks();
  configure({
    ...sinks,
    catalogReader: {
      lookupItems: async (_retailer: string, lookups: Array<{ index: number }>) =>
        lookups.map((l) => ({ index: l.index, gtin13: GTIN, itemReferenceId: 1, conversionFactor: 1, conversionVersion: 1 })),
      checkReferences: async () => { throw new Error("unused"); },
      getOrgProvisionalItem: async () => null,
      searchOrgProvisionalItems: async () => [],
      getActiveItem: async () => { throw new Error("unused"); },
    },
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  for (const table of ["workflow_audit_log", "received_receipts"]) {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_refuse_write ON ${table}`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_refuse_${table}()`);
  }
});

const receiptRow = (id: number) => db.receivedReceipt.findUniqueOrThrow({ where: { id } });
const lineRow = (id: number) => db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id } });
const eventTypes = async (id: number) =>
  (await db.workflowAuditLog.findMany({ where: { receivedReceiptId: id } })).map((r) => r.eventType);

/** A receipt in `state` whose one line is recognized. */
async function decidedReceipt(state: "pending_review" | "applying" | "apply_failed" = "pending_review") {
  const r = await makeReceipt({ state });
  await makeLineStatus(r.id, { recognitionStatus: "recognized", assignedGtin13: GTIN });
  return r;
}

describeDb("proceed and its audit row commit together", () => {
  it("writes the move to applying and receipt_proceeded", async () => {
    const r = await decidedReceipt();
    await receiptService.proceed(r.id);
    expect((await receiptRow(r.id)).state).toBe("applying");
    expect(await eventTypes(r.id)).toContain("receipt_proceeded");
  });

  it("leaves the receipt in review when receipt_proceeded fails", async () => {
    const r = await decidedReceipt();
    await failAudit("receipt_proceeded");
    await expect(receiptService.proceed(r.id)).rejects.toThrow("write refused");
    expect((await receiptRow(r.id)).state).toBe("pending_review");
  });
});

describeDb("retry and its audit row commit together", () => {
  it("writes the move to applying and receipt_retry_started", async () => {
    const r = await decidedReceipt("apply_failed");
    await receiptService.retryApply(r.id);
    expect((await receiptRow(r.id)).state).toBe("applying");
    expect(await eventTypes(r.id)).toContain("receipt_retry_started");
  });

  it("leaves the receipt failed when receipt_retry_started fails", async () => {
    const r = await decidedReceipt("apply_failed");
    await failAudit("receipt_retry_started");
    await expect(receiptService.retryApply(r.id)).rejects.toThrow("write refused");
    expect((await receiptRow(r.id)).state).toBe("apply_failed");
  });
});

describeDb("auto-proceed and its audit row commit together", () => {
  it("writes the move, auto_proceed_triggered, and pushes", async () => {
    const r = await decidedReceipt();
    await tryAutoProceedApply(r.id, r, MANAGER);
    expect((await receiptRow(r.id)).state).toBe("resolved");
    expect(await eventTypes(r.id)).toContain("auto_proceed_triggered");
  });

  it("leaves the receipt in review and pushes nothing when auto_proceed_triggered fails", async () => {
    const r = await decidedReceipt();
    await failAudit("auto_proceed_triggered");
    await expect(tryAutoProceedApply(r.id, r, MANAGER)).rejects.toThrow("write refused");
    expect((await receiptRow(r.id)).state).toBe("pending_review");
    expect(sinks.calls.expense).toHaveLength(0);
  });
});

describeDb("a push's settle and its audit row commit together", () => {
  it("writes resolved and receipt_apply_succeeded", async () => {
    const r = await decidedReceipt("applying");
    await receiptService.apply(r.id);
    expect((await receiptRow(r.id)).state).toBe("resolved");
    expect(await eventTypes(r.id)).toContain("receipt_apply_succeeded");
  });

  it("keeps the receipt applying, with the failure recorded, when receipt_apply_succeeded fails", async () => {
    const r = await decidedReceipt("applying");
    await failAudit("receipt_apply_succeeded");
    await expect(receiptService.apply(r.id)).rejects.toThrow("write refused");
    const row = await receiptRow(r.id);
    expect(row.state).toBe("applying");
    expect(row.validationNotes).toContain("write refused");
    expect(row.applyFirstFailedAt).not.toBeNull();
  });

  it("writes apply_failed and receipt_apply_failed when a leg fails", async () => {
    const r = await decidedReceipt("applying");
    sinks.fail.expense = true;
    expect(await receiptService.apply(r.id)).toMatchObject({ state: "apply_failed" });
    expect((await receiptRow(r.id)).state).toBe("apply_failed");
    expect(await eventTypes(r.id)).toContain("receipt_apply_failed");
  });

  it("keeps the failure recorded and the receipt retryable when receipt_apply_failed fails", async () => {
    const r = await decidedReceipt("applying");
    sinks.fail.expense = true;
    await failAudit("receipt_apply_failed");
    await expect(receiptService.apply(r.id)).rejects.toThrow("write refused");
    const row = await receiptRow(r.id);
    expect(row.state).toBe("applying");
    expect(row.validationNotes).toContain("write refused");
    expect(row.applyFirstFailedAt).not.toBeNull();
    await db.$executeRawUnsafe(`DROP TRIGGER test_refuse_write ON workflow_audit_log`);
    await receiptService.retryApply(r.id);
    expect(await eventTypes(r.id)).toContain("receipt_retry_started");
  });
});

describeDb("an unstamped leg's failure and its audit row commit together", () => {
  const refuseInventoryStamp = () =>
    refuse("received_receipts", "TG_OP = 'UPDATE' AND NEW.inventory_applied_at IS NOT NULL AND OLD.inventory_applied_at IS NULL");

  it("writes inventoryUnconfirmedAt and receipt_apply_failed", async () => {
    const r = await decidedReceipt("applying");
    await refuseInventoryStamp();
    expect(await receiptService.apply(r.id)).toMatchObject({ state: "applying" });
    expect((await receiptRow(r.id)).inventoryUnconfirmedAt).not.toBeNull();
    expect(await eventTypes(r.id)).toContain("receipt_apply_failed");
  });

  it("rolls inventoryUnconfirmedAt back, keeps the failure recorded and the receipt retryable when receipt_apply_failed fails", async () => {
    const r = await decidedReceipt("applying");
    await refuseInventoryStamp();
    await failAudit("receipt_apply_failed");
    await expect(receiptService.apply(r.id)).rejects.toThrow("write refused");
    const row = await receiptRow(r.id);
    expect(row.state).toBe("applying");
    expect(row.inventoryUnconfirmedAt).toBeNull();
    expect(row.validationNotes).toContain("write refused");
    expect(row.applyFirstFailedAt).not.toBeNull();
    for (const table of ["workflow_audit_log", "received_receipts"]) await db.$executeRawUnsafe(`DROP TRIGGER test_refuse_write ON ${table}`);
    await receiptService.retryApply(r.id);
    expect(await eventTypes(r.id)).toContain("receipt_retry_started");
  });
});

describeDb("a person's matching re-run and its audit rows commit together", () => {
  async function pendingReceipt() {
    const r = await makeReceipt({ lineCount: 1 });
    const line = await makeLineStatus(r.id, { recognitionStatus: "unrecognized" });
    const row = await db.receivedReceipt.update({ where: { id: r.id }, data: { matchingPendingSince: new Date() } });
    return { row, line };
  }

  it("writes the match, line_matched, the cleared flag and matching_ran", async () => {
    const { row, line } = await pendingReceipt();
    expect(await rerunMatching(row, MANAGER)).toBe("ran");
    expect((await lineRow(line.id)).recognitionStatus).toBe("recognized");
    expect((await receiptRow(row.id)).matchingPendingSince).toBeNull();
    expect(await eventTypes(row.id)).toEqual(expect.arrayContaining(["line_matched", "matching_ran"]));
  });

  it("leaves the line unrecognized when line_matched fails", async () => {
    const { row, line } = await pendingReceipt();
    await failAudit("line_matched");
    await expect(rerunMatching(row, MANAGER)).rejects.toThrow("write refused");
    expect((await lineRow(line.id)).recognitionStatus).toBe("unrecognized");
  });

  it("leaves matching pending when matching_ran fails", async () => {
    const { row } = await pendingReceipt();
    await failAudit("matching_ran");
    await expect(rerunMatching(row, MANAGER)).rejects.toThrow("write refused");
    expect((await receiptRow(row.id)).matchingPendingSince).not.toBeNull();
  });
});

describeDb("a catalog remap and its audit row commit together", () => {
  const approved: OrgEventRecord = {
    id: 5,
    orgId: TEST_ORG_ID,
    eventType: "provisional_approved",
    payload: JSON.stringify({ version: 1, provisionalGtin13: PROV, realGtin13: GTIN, name: "Widget", conversionFactor: 6, conversionVersion: 2 }),
  };

  async function provisionalLine() {
    const r = await makeReceipt();
    return makeLineStatus(r.id, { recognitionStatus: "provisional", provisionalItemGtin13: PROV, proposedName: "Widget" });
  }

  it("writes the remap and line_remapped", async () => {
    const line = await provisionalLine();
    await orgEventConsumer.onOrgEvents([approved]);
    expect((await lineRow(line.id)).assignedGtin13).toBe(GTIN);
    expect(await eventTypes(line.receivedReceiptId)).toContain("line_remapped");
  });

  it("leaves the line provisional and the event failed when line_remapped fails", async () => {
    const line = await provisionalLine();
    await failAudit("line_remapped");
    await orgEventConsumer.onOrgEvents([approved]);
    expect((await lineRow(line.id)).recognitionStatus).toBe("provisional");
    expect(await db.workflowFailedOrgEvent.findUnique({ where: { id: 5 } })).not.toBeNull();
  });
});
