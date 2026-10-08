import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import type { ReimbursementStatus } from "../../contract";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { ALICE, BOB, FINANCE, actAs, clearAll, configure, manualDetails, recordingPorts, stateOf, textFile } from "../helpers/setup";

let ports: ReturnType<typeof recordingPorts>;

beforeEach(async () => {
  await clearAll();
  ports = recordingPorts();
  configure({ receiptSink: ports.receiptSink, donorSink: ports.donorSink });
});

describeDb("submitter scope", () => {
  it("a submitter cannot see or act on another person's receipt", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ receiptTotal: "1" }) });
    actAs(BOB);
    await expect(receiptService.get(r.id, "submitter")).rejects.toMatchObject({ statusCode: 404 });
    await expect(receiptService.discard(r.id, "submitter")).rejects.toMatchObject({ statusCode: 404 });
    await expect(receiptService.getFile(r.id, "submitter")).rejects.toMatchObject({ statusCode: 404 });
    expect(await receiptService.listMine()).toEqual([]);
  });

  it("donor names never reach the submitter; finance reads them", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails(), isInKind: true, donor: { self: true } });
    expect(r).not.toHaveProperty("donorFirstName");
    const mine = await receiptService.get(r.id, "submitter");
    expect(mine).not.toHaveProperty("donorFirstName");
    expect((await receiptService.listMine())[0]).not.toHaveProperty("donorLastName");
    actAs(FINANCE);
    expect(await receiptService.get(r.id, "finance")).toMatchObject({ donorFirstName: "Alice", donorLastName: "Adams" });
  });

  it("every file read is audited without bytes", async () => {
    const r = await receiptService.upload(textFile("file-bytes"), "text/plain", { details: manualDetails() });
    const file = await receiptService.getFile(r.id, "submitter");
    expect(file.mimeType).toBe("text/plain");
    expect(file.bytes.toString()).toContain("file-bytes");
    const row = await db.receiptAuditLog.findFirst({ where: { receiptId: r.id, action: "file_viewed" } });
    expect(row).toMatchObject({ userId: ALICE.id, valueAfter: null });
  });

  it("no receipt read returns the file column", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    actAs(FINANCE);
    for (const v of [await receiptService.get(r.id, "finance"), ...(await receiptService.listForOrg())]) {
      expect(v).not.toHaveProperty("fileBlob");
    }
  });
});

describeDb("submitter review", () => {
  it("confirming an owed receipt finalizes it", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails(), needsReimbursement: true });
    expect(r.state).toBe("submitter_review");
    await receiptService.submitterConfirm(r.id);
    expect(await stateOf(r.id)).toBe("receipt_finalized");
    expect(ports.calls.pushes[0]).toMatchObject({ needsReimbursement: true, reimburseePersonId: ALICE.id });
  });

  it("dropping the reimbursement clears the reimbursee", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails(), needsReimbursement: true });
    const after = await receiptService.setReimbursement(r.id, { needsReimbursement: false });
    expect(after).toMatchObject({ needsReimbursement: false, reimburseePersonId: null, reimbursementFor: null });
  });
});

describeDb("My receipts", () => {
  it("an owed receipt reads 'not yet paid' and stays visible under Hide completed until X12 says paid", async () => {
    const owed = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ receiptTotal: "20" }), needsReimbursement: true });
    await receiptService.submitterConfirm(owed.id);
    const plain = await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ receiptTotal: "20", retailer: "Other" }) });
    expect(plain.state).toBe("receipt_finalized");

    const all = await receiptService.listMine();
    expect(all.find((r) => r.id === owed.id)).toMatchObject({ reimbursement: { paidOn: null }, complete: false });
    expect(all.find((r) => r.id === plain.id)).toMatchObject({ reimbursement: null, complete: true });
    expect((await receiptService.listMine({ hideCompleted: true })).map((r) => r.id)).toEqual([owed.id]);

    const paid: ReimbursementStatus = {
      forReceipts: async (ids) => new Map(ids.map((id) => [id, { paidOn: "2026-10-01" }])),
    };
    configure({ receiptSink: ports.receiptSink, reimbursementStatus: paid });
    expect(await receiptService.listMine({ hideCompleted: true })).toEqual([]);
  });

  it("asks X12 only about the caller's own owed receipts", async () => {
    const asked: string[][] = [];
    configure({
      receiptSink: ports.receiptSink,
      reimbursementStatus: { forReceipts: async (ids) => (asked.push(ids), new Map()) },
    });
    const mine = await receiptService.upload(textFile(), "text/plain", { details: manualDetails(), needsReimbursement: true });
    actAs(BOB);
    await receiptService.upload(textFile(), "text/plain", { details: manualDetails({ retailer: "Bob's" }), needsReimbursement: true });
    actAs(ALICE);
    await receiptService.listMine();
    expect(asked.at(-1)).toEqual([mine.id]);
  });
});
