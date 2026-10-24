import { beforeEach, expect, it } from "vitest";
import type { ReceiptPrincipal } from "../../contract";
import { db } from "../../db";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { ALICE, BOB, FINANCE, actAs, actions, clearAll, configure, manualDetails, recordingPorts, stateOf, textFile } from "../helpers/setup";

beforeEach(async () => {
  await clearAll();
  configure({ receiptSink: recordingPorts().receiptSink });
});

describeDb("duplicate detection", () => {
  it("flags a re-upload of the same file against the original", async () => {
    const file = textFile();
    const first = await receiptService.upload(file, "text/plain", { details: manualDetails({ retailer: "A" }) });
    const second = await receiptService.upload(file, "text/plain", { details: manualDetails({ retailer: "B" }) });
    expect(first.state).toBe("receipt_finalized");
    expect(second.state).toBe("duplicate_flagged");
    expect(second.duplicateSuspectReceiptId).toBe(first.id);
  });

  it("flags the composite (retailer, date, total) match", async () => {
    await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    const second = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    expect(second.state).toBe("duplicate_flagged");
  });

  it("two identical files uploaded at once: exactly one is flagged, against the other", async () => {
    for (let round = 0; round < 5; round++) {
      await clearAll();
      const file = textFile();
      const [a, b] = await Promise.all([
        receiptService.upload(file, "text/plain", { details: manualDetails({ retailer: "A" }) }),
        receiptService.upload(file, "text/plain", { details: manualDetails({ retailer: "B" }) }),
      ]);
      const flagged = [a, b].filter((r) => r.state === "duplicate_flagged");
      expect(flagged).toHaveLength(1);
      const other = flagged[0].id === a.id ? b : a;
      expect(flagged[0].duplicateSuspectReceiptId).toBe(other.id);
    }
  });

  it("a cleared flag sticks while the original still exists, and the clear is audited", async () => {
    const file = textFile();
    await receiptService.upload(file, "text/plain", { details: manualDetails() });
    const dup = await receiptService.upload(file, "text/plain", { details: manualDetails() });
    expect(dup.state).toBe("duplicate_flagged");

    actAs(FINANCE);
    await receiptService.clearDuplicate(dup.id);
    expect(await stateOf(dup.id)).toBe("receipt_finalized");

    const cleared = await db.receiptAuditLog.findFirst({ where: { receiptId: dup.id, action: "duplicate_cleared" } });
    expect(cleared).toMatchObject({ userId: FINANCE.id, username: FINANCE.name });
    expect(cleared?.changedAt).toBeInstanceOf(Date);
    const detail = await db.receiptDetail.findUnique({ where: { id: dup.id } });
    expect(detail?.duplicateFlagClearedAt).toBeInstanceOf(Date);
  });
});

const HOUSEMATE: ReceiptPrincipal = { ...FINANCE, id: 970, name: "housemate" };

describeDb("discarding a suspected original", () => {
  beforeEach(() => {
    const ports = recordingPorts();
    configure({ receiptSink: ports.receiptSink, households: { householdOf: async (ids) => (ids.includes(BOB.id) ? [BOB.id, HOUSEMATE.id] : []) } });
  });

  /** ALICE's original waits in finance review; BOB's re-upload of the same file is flagged against it. */
  async function pair() {
    const file = textFile();
    const details = manualDetails({ receiptDate: "2999-01-01" });
    actAs(ALICE);
    const original = await receiptService.upload(file, "text/plain", { details });
    actAs(BOB);
    const flagged = await receiptService.upload(file, "text/plain", { details });
    expect([original.state, flagged.state, flagged.duplicateSuspectReceiptId]).toEqual(["financial_review", "duplicate_flagged", original.id]);
    return { original, flagged };
  }

  it.each([
    ["the flagged receipt's uploader", BOB],
    ["someone in that uploader's household", HOUSEMATE],
  ])("refuses %s, and audits the refusal on the flagged receipt", async (_who, actor) => {
    const { original, flagged } = await pair();
    actAs(actor);
    await expect(receiptService.discard(original.id, "finance")).rejects.toMatchObject({ status: 403 });
    expect(await stateOf(original.id)).toBe("financial_review");
    const refused = await db.receiptAuditLog.findFirst({ where: { receiptId: flagged.id, action: "decision_refused" } });
    expect(refused).toMatchObject({ userId: actor.id, valueAfter: "discard the suspected original" });
  });

  it("discards it for unconflicted finance and records the discard on the flagged receipt", async () => {
    const { original, flagged } = await pair();
    actAs(FINANCE);
    await receiptService.discard(original.id, "finance");
    expect(await stateOf(original.id)).toBe("discarded");
    expect(await stateOf(flagged.id)).toBe("duplicate_flagged");
    const row = await db.receiptAuditLog.findFirst({ where: { receiptId: flagged.id, action: "suspected_original_discarded" } });
    expect(row).toMatchObject({ userId: FINANCE.id, valueAfter: original.id });
  });

  it("lets the original's uploader discard their own receipt", async () => {
    const { original, flagged } = await pair();
    actAs(ALICE);
    await receiptService.discard(original.id, "submitter");
    expect(await stateOf(original.id)).toBe("discarded");
    expect(await actions(flagged.id)).not.toContain("suspected_original_discarded");
  });
});
