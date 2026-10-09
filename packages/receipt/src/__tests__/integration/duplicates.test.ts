import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { FINANCE, actAs, clearAll, configure, manualDetails, recordingPorts, stateOf, textFile } from "../helpers/setup";

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
