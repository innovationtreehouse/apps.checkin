import { beforeEach, expect, it } from "vitest";
import type { ReceiptPrincipal } from "../../contract";
import { db } from "../../db";
import { checkDuplicate } from "../../lib/receipt-flow";
import { receiptRepo } from "../../repositories/receipt";
import { getOrgId } from "../../runtime";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { ALICE, BOB, FINANCE, actAs, actions, clearAll, configure, manualDetails, okOcr, recordingPorts, stateOf, textFile } from "../helpers/setup";

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

  it("matches the retailer ignoring case and extra whitespace", async () => {
    const first = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ retailer: "Amazon" }) });
    const second = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ retailer: " amazon  " }) });
    expect(second.state).toBe("duplicate_flagged");
    expect(second.duplicateSuspectReceiptId).toBe(first.id);
  });

  it.each(["orderNumber", "receiptNumber"])("matches %s under a retailer differing in case and spacing", async (field) => {
    const first = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ retailer: "Acme  Hardware", receiptDate: "2999-01-01" }) });
    const second = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ retailer: "acme hardware ", receiptDate: "2999-01-02" }) });
    await db.receiptDetail.updateMany({ where: { id: { in: [first.id, second.id] } }, data: { [field]: "N-1" } });
    const row = await receiptRepo.find(second.id, await getOrgId());
    expect(row && (await checkDuplicate(row))).toBe(first.id);
  });

  it.each(["orderNumber", "receiptNumber"])("does not match an empty %s", async (field) => {
    const first = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ receiptDate: "2999-01-01" }) });
    const second = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ receiptDate: "2999-01-02" }) });
    await db.receiptDetail.updateMany({ where: { id: { in: [first.id, second.id] } }, data: { [field]: "" } });
    const row = await receiptRepo.find(second.id, await getOrgId());
    expect(row && (await checkDuplicate(row))).toBeNull();
  });

  /** Two receipts on different dates carrying `a` and `b` in `field`: the earlier one's id, and what the later one matched. */
  async function numberMatch(field: string, a: string, b: string) {
    const first = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ receiptDate: "2999-01-01" }) });
    const second = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ receiptDate: "2999-01-02" }) });
    await db.receiptDetail.update({ where: { id: first.id }, data: { [field]: a } });
    await db.receiptDetail.update({ where: { id: second.id }, data: { [field]: b } });
    const row = await receiptRepo.find(second.id, await getOrgId());
    return { first: first.id, matched: row && (await checkDuplicate(row)) };
  }

  it.each(["orderNumber", "receiptNumber"])("matches %s with a leading # dropped", async (field) => {
    const { first, matched } = await numberMatch(field, "#12345", "12345");
    expect(matched).toBe(first);
  });

  it.each(["orderNumber", "receiptNumber"])("matches %s ignoring case and outer spaces", async (field) => {
    const { first, matched } = await numberMatch(field, " ab-12 ", "AB-12");
    expect(matched).toBe(first);
  });

  it.each(["orderNumber", "receiptNumber"])("matches %s ignoring inner spaces", async (field) => {
    const { first, matched } = await numberMatch(field, "AB 12", "ab12");
    expect(matched).toBe(first);
  });

  it.each(["orderNumber", "receiptNumber"])("does not match a different %s once folded", async (field) => {
    const { matched } = await numberMatch(field, "#12345", "12346");
    expect(matched).toBeNull();
  });

  it.each(["orderNumber", "receiptNumber"])("does not match a %s that folds to empty", async (field) => {
    const { matched } = await numberMatch(field, " # ", "#");
    expect(matched).toBeNull();
  });

  it("does not match a different retailer name on the same date and total", async () => {
    await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ retailer: "Amazon" }) });
    const second = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ retailer: "Amazon.com" }) });
    expect(second.state).not.toBe("duplicate_flagged");
  });

  it("two identical files uploaded at once: at least one is held, and both are in one group", async () => {
    for (let round = 0; round < 5; round++) {
      await clearAll();
      const file = textFile();
      const [a, b] = await Promise.all([
        receiptService.upload(file, "text/plain", { details: manualDetails({ retailer: "A" }) }),
        receiptService.upload(file, "text/plain", { details: manualDetails({ retailer: "B" }) }),
      ]);
      expect(await Promise.all([a.id, b.id].map(stateOf))).toContain("duplicate_flagged");
      const members = (await receiptService.duplicateGroup(a.id)).members.map((m) => m.id);
      expect(members.sort()).toEqual([a.id, b.id].sort());
    }
  });

  it("Different purchases finalizes the copy, and the decision and the clear are audited", async () => {
    const file = textFile();
    const first = await receiptService.upload(file, "text/plain", { details: manualDetails() });
    const dup = await receiptService.upload(file, "text/plain", { details: manualDetails() });
    expect(dup.state).toBe("duplicate_flagged");

    actAs(FINANCE);
    await receiptService.differentPurchases(dup.id, [first.id, dup.id]);
    expect(await stateOf(dup.id)).toBe("receipt_finalized");

    const cleared = await db.receiptAuditLog.findFirst({ where: { receiptId: dup.id, action: "duplicate_cleared" } });
    expect(cleared).toMatchObject({ userId: FINANCE.id, username: FINANCE.name });
    for (const [receiptId, other] of [[first.id, dup.id], [dup.id, first.id]]) {
      const decided = await db.receiptAuditLog.findFirst({ where: { receiptId, action: "duplicate_pair_different" } });
      expect(decided).toMatchObject({ userId: FINANCE.id, valueAfter: other });
    }
  });
});

describeDb("deciding a duplicate group", () => {
  beforeEach(() => configure({ receiptSink: recordingPorts().receiptSink, ocr: okOcr() }));

  const pairDecision = (a: string, b: string) =>
    db.receiptPairDecision.findFirst({ where: { receiptId: a < b ? a : b, otherReceiptId: a < b ? b : a } });

  it("Undo of Not this one deletes the pair decision, audits it, and the match returns", async () => {
    const a = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    const b = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    const c = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });

    actAs(FINANCE);
    const after = await receiptService.notThisOne(c.id, a.id);
    expect(after).toMatchObject({ members: [{ id: b.id }, { id: c.id }], dismissed: [a.id] });
    expect(await stateOf(c.id)).toBe("duplicate_flagged");

    const undone = await receiptService.undoNotThisOne(c.id, a.id);
    expect(undone.members.map((m) => m.id)).toEqual([a.id, b.id, c.id]);
    expect(undone.dismissed).toEqual([]);
    expect(await pairDecision(a.id, c.id)).toBeNull();
    expect(await actions(c.id)).toEqual(expect.arrayContaining(["duplicate_pair_different", "duplicate_pair_undone"]));
    expect(await actions(a.id)).toEqual(expect.arrayContaining(["duplicate_pair_different", "duplicate_pair_undone"]));
  });

  it("Undo is refused once the viewed receipt has left the hold, and the decision stands", async () => {
    const a = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    const b = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    actAs(FINANCE);
    await receiptService.notThisOne(b.id, a.id);
    expect(await stateOf(b.id)).toBe("receipt_finalized");

    await expect(receiptService.undoNotThisOne(b.id, a.id)).rejects.toMatchObject({ status: 409 });
    expect(await pairDecision(a.id, b.id)).toMatchObject({ kind: "different" });
  });

  it("Undo is refused once the dismissal released the match, which stays decided", async () => {
    // The original that keeps B held after B dismisses C.
    await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    const scan = textFile();
    const b = await receiptService.upload(scan, "text/plain", { details: manualDetails() });
    const c = await receiptService.upload(scan, "text/plain", { details: manualDetails({ retailer: "Other Store" }) });
    expect(await stateOf(c.id)).toBe("duplicate_flagged");

    actAs(FINANCE);
    await receiptService.notThisOne(b.id, c.id);
    expect([await stateOf(b.id), await stateOf(c.id)]).toEqual(["duplicate_flagged", "receipt_finalized"]);
    await expect(receiptService.undoNotThisOne(b.id, c.id)).rejects.toMatchObject({ status: 409 });
    expect(await pairDecision(b.id, c.id)).toMatchObject({ kind: "different" });
  });

  it("Not this one on a match already dismissed answers 409", async () => {
    const a = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    const b = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    const c = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    actAs(FINANCE);
    await receiptService.notThisOne(c.id, a.id);
    await expect(receiptService.notThisOne(c.id, a.id)).rejects.toMatchObject({ status: 409 });
    expect(await stateOf(b.id)).toBe("duplicate_flagged");
  });

  it("Not this one is not refused for a copy that arrived after the panel was drawn", async () => {
    const a = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    const b = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    const c = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    actAs(FINANCE);
    const fresh = await receiptService.notThisOne(b.id, a.id);
    expect(fresh.members.map((m) => m.id)).toEqual([b.id, c.id]);
    expect(await stateOf(b.id)).toBe("duplicate_flagged");
  });

  it("a stale Different purchases names the new copy in its 409", async () => {
    const a = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    const b = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    actAs(FINANCE);
    await expect(receiptService.differentPurchases(b.id, [a.id, b.id])).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/^A new possible copy arrived after you opened this: /),
    });
    expect(await pairDecision(a.id, b.id)).toBeNull();
  });

  it("a decision replacing an earlier one for the same pair is audited again", async () => {
    const file = textFile();
    actAs(ALICE);
    const a = await receiptService.upload(file, "text/plain", {});
    const b = await receiptService.upload(file, "text/plain", { details: manualDetails() });
    actAs(FINANCE);
    await receiptService.keepThisOne(b.id, [a.id, b.id]);
    expect(await pairDecision(a.id, b.id)).toMatchObject({ kind: "copy_of", copyReceiptId: a.id });

    actAs(ALICE);
    const c = await receiptService.upload(file, "text/plain", { details: manualDetails() });
    actAs(FINANCE);
    await receiptService.differentPurchases(c.id, [a.id, b.id, c.id]);
    expect(await pairDecision(a.id, b.id)).toMatchObject({ kind: "different", copyReceiptId: null });
    expect(await actions(a.id)).toEqual(expect.arrayContaining(["duplicate_pair_copy_of", "duplicate_pair_different"]));
  });

  it("Keep this one beside an already rejected match records it as a copy and releases the kept receipt", async () => {
    const file = textFile();
    actAs(ALICE);
    const a = await receiptService.upload(file, "text/plain", { details: manualDetails({ receiptDate: "2999-01-01" }) });
    actAs(FINANCE);
    await receiptService.rejectFinancial(a.id, "personal purchase");
    actAs(ALICE);
    const b = await receiptService.upload(file, "text/plain", { details: manualDetails() });
    expect(b.state).toBe("duplicate_flagged");

    actAs(FINANCE);
    await receiptService.keepThisOne(b.id, [a.id, b.id]);
    expect([await stateOf(a.id), await stateOf(b.id)]).toEqual(["rejected", "receipt_finalized"]);
    expect(await pairDecision(a.id, b.id)).toMatchObject({ kind: "copy_of", copyReceiptId: a.id });
    const member = (await receiptService.duplicateGroup(b.id)).members.find((m) => m.id === a.id);
    expect(member).toMatchObject({ label: expect.stringMatching(/^Rejected on .*: personal purchase$/), copyOfId: b.id });
  });

  it("Keep this one beside a finalized copy is refused and writes nothing", async () => {
    const file = textFile();
    const a = await receiptService.upload(file, "text/plain", { details: manualDetails() });
    const b = await receiptService.upload(file, "text/plain", { details: manualDetails() });
    expect([a.state, b.state]).toEqual(["receipt_finalized", "duplicate_flagged"]);

    actAs(FINANCE);
    await expect(receiptService.keepThisOne(b.id, [a.id, b.id])).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/^A finalized copy exists/) });
    expect(await pairDecision(a.id, b.id)).toBeNull();
    expect(await stateOf(b.id)).toBe("duplicate_flagged");
  });

  it("Keep this one rejects the open copy with the kept receipt named, and labels it so", async () => {
    const file = textFile();
    actAs(ALICE);
    const a = await receiptService.upload(file, "text/plain", {});
    const b = await receiptService.upload(file, "text/plain", { details: manualDetails({ retailer: "Home Depot" }) });
    actAs(FINANCE);
    await receiptService.keepThisOne(b.id, [a.id, b.id]);
    const row = await db.receiptAuditLog.findFirst({ where: { receiptId: a.id, action: "reject_financial" } });
    // Both were uploaded today, so the kept receipt is told apart by its upload time.
    expect(row?.valueAfter).toMatch(/^Copy of Home Depot, uploaded \d{1,2} \w{3}, \d{2}:\d{2}$/);
    const member = (await receiptService.duplicateGroup(b.id)).members.find((m) => m.id === a.id);
    expect(member).toMatchObject({ label: `Rejected as a copy of ${row?.valueAfter?.slice("Copy of ".length)}`, copyOfId: b.id });
  });
});

const HOUSEMATE: ReceiptPrincipal = { ...FINANCE, id: 970, name: "housemate" };

describeDb("deciding on a suspected original", () => {
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
    await expect(receiptService.rejectFinancial(original.id, "a copy")).rejects.toMatchObject({ status: 403 });
    expect(await stateOf(original.id)).toBe("financial_review");
    const refused = await db.receiptAuditLog.findFirst({ where: { receiptId: flagged.id, action: "decision_refused" } });
    expect(refused).toMatchObject({ userId: actor.id, valueAfter: "reject the suspected original" });
  });

  it("rejects it for unconflicted finance and records the rejection on the flagged receipt", async () => {
    const { original, flagged } = await pair();
    actAs(FINANCE);
    await receiptService.rejectFinancial(original.id, "a copy");
    expect(await stateOf(original.id)).toBe("rejected");
    expect(await stateOf(flagged.id)).toBe("duplicate_flagged");
    const row = await db.receiptAuditLog.findFirst({ where: { receiptId: flagged.id, action: "suspected_original_rejected" } });
    expect(row).toMatchObject({ userId: FINANCE.id, valueAfter: original.id });
  });

  it("lets the original's uploader discard their own receipt", async () => {
    const { original, flagged } = await pair();
    actAs(ALICE);
    await receiptService.discard(original.id, "submitter");
    expect(await stateOf(original.id)).toBe("discarded");
    expect(await actions(flagged.id)).not.toContain("suspected_original_rejected");
  });
});
