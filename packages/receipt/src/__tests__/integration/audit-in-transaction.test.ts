import { afterEach, beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { runFullFlow } from "../../lib/receipt-flow";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { ALICE, BOB, FINANCE, actAs, actions, clearAll, configure, manualDetails, recordingPorts, stateOf, textFile, uploadRead } from "../helpers/setup";

/** Makes Postgres refuse every audit row with one of these actions, whichever client writes it. */
async function failAudit(...actionNames: string[]): Promise<void> {
  const list = actionNames.map((a) => `'${a}'`).join(", ");
  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION test_fail_audit() RETURNS trigger AS $$
    BEGIN
      IF NEW.action IN (${list}) THEN RAISE EXCEPTION 'audit write refused: %', NEW.action; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await db.$executeRawUnsafe(`CREATE TRIGGER test_fail_audit BEFORE INSERT ON receipt_audit_log FOR EACH ROW EXECUTE FUNCTION test_fail_audit()`);
}

beforeEach(async () => {
  await clearAll();
  configure({ receiptSink: recordingPorts().receiptSink });
  actAs(ALICE);
});

afterEach(async () => {
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_fail_audit ON receipt_audit_log`);
  await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_fail_audit()`);
});

/** ALICE's receipt, never pushed, moved straight to `state`. */
async function aliceReceiptIn(state: string): Promise<string> {
  actAs(ALICE);
  const r = await uploadRead(textFile(), "text/plain", { details: manualDetails({ receiptTotal: "25.00" }) });
  await db.receiptDetail.update({ where: { id: r.id }, data: { state } });
  return r.id;
}

/** An `uploaded` receipt whose lines do not add up, so the flow sends it to validation_failed. */
async function unbalancedReceipt(): Promise<string> {
  const id = await aliceReceiptIn("uploaded");
  await db.receiptDetail.update({ where: { id }, data: { receiptTotalCents: 99_99 } });
  return id;
}

/** ALICE's original in finance review, and BOB's re-upload of the same file held against it. */
async function heldPair() {
  const file = textFile();
  const details = manualDetails({ receiptDate: "2999-01-01" });
  actAs(ALICE);
  const original = await uploadRead(file, "text/plain", { details });
  actAs(BOB);
  const flagged = await uploadRead(file, "text/plain", { details });
  expect([original.state, flagged.state]).toEqual(["financial_review", "duplicate_flagged"]);
  return { original, flagged };
}

describeDb("a flow step and its audit row commit together", () => {
  it("writes the step and its pipeline_transition row", async () => {
    const id = await unbalancedReceipt();
    await runFullFlow(id, null);
    expect(await stateOf(id)).toBe("validation_failed");
    expect(await actions(id)).toContain("pipeline_transition");
  });

  it("rolls the step back when its audit row fails, and records the flow error instead", async () => {
    const id = await unbalancedReceipt();
    await failAudit("pipeline_transition");
    await expect(runFullFlow(id, null)).rejects.toThrow("audit write refused");
    expect(await stateOf(id)).toBe("flow_error");
    expect(await actions(id)).toContain("pipeline_failed");
  });

  it("rolls the flow error back when its pipeline_failed row fails too", async () => {
    const id = await unbalancedReceipt();
    await failAudit("pipeline_transition", "pipeline_failed");
    await expect(runFullFlow(id, null)).rejects.toThrow("audit write refused");
    expect(await stateOf(id)).toBe("uploaded");
  });
});

describeDb("a service step and its audit row commit together", () => {
  it("writes a discard and its row", async () => {
    const id = await aliceReceiptIn("submitter_review");
    await receiptService.discard(id, "submitter");
    expect(await stateOf(id)).toBe("discarded");
    expect(await actions(id)).toContain("discarded");
  });

  it("rolls a discard back when its audit row fails", async () => {
    const id = await aliceReceiptIn("submitter_review");
    await failAudit("discarded");
    await expect(receiptService.discard(id, "submitter")).rejects.toThrow("audit write refused");
    expect(await stateOf(id)).toBe("submitter_review");
  });

  it("writes a duplicate release and the duplicate_cleared row that undo reads", async () => {
    const { original, flagged } = await heldPair();
    actAs(ALICE);
    await receiptService.discard(original.id, "submitter");
    expect(await stateOf(flagged.id)).not.toBe("duplicate_flagged");
    expect(await actions(flagged.id)).toContain("duplicate_cleared");
  });

  it("keeps the receipt held when its duplicate_cleared row fails", async () => {
    const { original, flagged } = await heldPair();
    await failAudit("duplicate_cleared");
    actAs(ALICE);
    await expect(receiptService.discard(original.id, "submitter")).rejects.toThrow("audit write refused");
    expect(await stateOf(flagged.id)).toBe("duplicate_flagged");
  });
});

describeDb("a finance rejection and its rows on held receipts commit together", () => {
  it("writes the rejection and suspected_original_rejected on the held receipt", async () => {
    const { original, flagged } = await heldPair();
    actAs(FINANCE);
    await receiptService.rejectFinancial(original.id, "a copy");
    expect(await stateOf(original.id)).toBe("rejected");
    expect(await actions(flagged.id)).toContain("suspected_original_rejected");
  });

  it("rolls the rejection back when the held receipt's row fails", async () => {
    const { original } = await heldPair();
    await failAudit("suspected_original_rejected");
    actAs(FINANCE);
    await expect(receiptService.rejectFinancial(original.id, "a copy")).rejects.toThrow("audit write refused");
    expect(await stateOf(original.id)).toBe("financial_review");
  });
});

describeDb("acknowledging a rejection and its audit row commit together", () => {
  const acknowledgedAt = async (id: string) =>
    (await db.receiptDetail.findUniqueOrThrow({ where: { id }, select: { rejectionAcknowledgedAt: true } })).rejectionAcknowledgedAt;

  it("writes the acknowledgement and its row", async () => {
    const id = await aliceReceiptIn("rejected");
    await receiptService.acknowledgeRejection(id);
    expect(await acknowledgedAt(id)).not.toBeNull();
    expect(await actions(id)).toContain("rejection_acknowledged");
  });

  it("rolls the acknowledgement back when its audit row fails", async () => {
    const id = await aliceReceiptIn("rejected");
    await failAudit("rejection_acknowledged");
    await expect(receiptService.acknowledgeRejection(id)).rejects.toThrow("audit write refused");
    expect(await acknowledgedAt(id)).toBeNull();
  });
});
