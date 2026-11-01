import { ServiceError } from "@checkin/component-kit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { db } from "../../db";
import { repushUnpushed, resendDonorSync } from "../../services/catchUp";
import { importReceipts } from "../../services/importService";
import { receiptRepo } from "../../repositories/receipt";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { ALICE, TEST_ORG_ID, clearAll, configure, manualDetails, okOcr, recordingPorts, textFile } from "../helpers/setup";

let ports: ReturnType<typeof recordingPorts>;

beforeEach(async () => {
  await clearAll();
  ports = recordingPorts();
  configure({ receiptSink: ports.receiptSink, donorSink: ports.donorSink });
});

afterEach(() => vi.restoreAllMocks());

const donorSync = async (id: string) => (await db.receipt.findUniqueOrThrow({ where: { id } })).donorSync;
const badMath = () => manualDetails({ receiptTotal: "1" });

describeDb("in-kind mark and donor (X13)", () => {
  it("refuses a typed-in donor the host's check refuses, before anything is written", async () => {
    const refuse = vi.fn(async () => {
      throw new ServiceError(403, "own household");
    });
    const typed = { isInKind: true, donor: { firstName: "Dana", lastName: "Donor" } };
    await expect(receiptService.upload(textFile(), "text/plain", { details: manualDetails(), ...typed }, refuse)).rejects.toMatchObject({ status: 403 });
    expect(await db.receipt.count()).toBe(0);

    const r = await receiptService.upload(textFile(), "text/plain", { details: badMath() });
    await expect(receiptService.setInKind(r.id, typed, refuse)).rejects.toMatchObject({ status: 403 });
    expect(await db.receipt.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ isInKind: false, donorLastName: null });
    expect(refuse).toHaveBeenCalledTimes(2);
  });

  it("reserves no OCR call for an upload whose typed-in donor is refused", async () => {
    const extract = vi.fn(okOcr().extract);
    configure({ receiptSink: ports.receiptSink, donorSink: ports.donorSink, ocr: { extract } });
    const refuse = vi.fn(async () => {
      throw new ServiceError(403, "own household");
    });
    const typed = { isInKind: true, donor: { firstName: "Dana", lastName: "Donor" } };
    await expect(receiptService.upload(textFile(), "text/plain", typed, refuse)).rejects.toMatchObject({ status: 403 });
    expect(await db.receiptAuditLog.count({ where: { action: "ocr_call" } })).toBe(0);
    expect(extract).not.toHaveBeenCalled();
    expect(await db.receipt.count()).toBe(0);
  });

  it("records a typed-in donor the check passes", async () => {
    const pass = vi.fn(async () => undefined);
    const typed = await receiptService.upload(textFile(), "text/plain", { details: badMath(), isInKind: true, donor: { firstName: "Dana", lastName: "Donor" } }, pass);
    expect(pass).toHaveBeenCalledTimes(1);
    expect(await db.receipt.findUniqueOrThrow({ where: { id: typed.id } })).toMatchObject({ isInKind: true, donorLastName: "Donor" });
  });

  it("never checks \"I am the donor\" or a cleared mark", async () => {
    const pass = vi.fn(async () => undefined);
    const self = await receiptService.upload(textFile(), "text/plain", { details: badMath(), isInKind: true, donor: { self: true } }, pass);
    await receiptService.setInKind(self.id, { isInKind: true, donor: { self: true } }, pass);
    await receiptService.setInKind(self.id, { isInKind: false }, pass);
    expect(pass).not.toHaveBeenCalled();
  });

  it("requires a donor and forbids reimbursement", async () => {
    await expect(receiptService.upload(textFile(), "text/plain", { details: manualDetails(), isInKind: true })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      receiptService.upload(textFile(), "text/plain", {
        details: manualDetails(),
        isInKind: true,
        donor: { self: true },
        needsReimbursement: true,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("'I am the donor' sends the uploader's names; the push carries only isInKind", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails(), isInKind: true, donor: { self: true } });
    expect(ports.calls.donors).toEqual([
      { orgId: TEST_ORG_ID, receiptId: r.id, donor: { firstName: ALICE.firstName, lastName: ALICE.lastName, companyName: null }, seq: 0 },
    ]);
    expect(await donorSync(r.id)).toBe("synced");
    expect(ports.calls.pushes[0].isInKind).toBe(true);
    expect(ports.calls.pushes[0]).not.toHaveProperty("donorFirstName");
  });

  it("a typed donor is sent as typed", async () => {
    await receiptService.upload(textFile(), "text/plain", {
      details: manualDetails(),
      isInKind: true,
      donor: { firstName: "Dana", lastName: "Donor", companyName: "Donor Co" },
    });
    expect(ports.calls.donors[0].donor).toEqual({ firstName: "Dana", lastName: "Donor", companyName: "Donor Co" });
  });

  it("a failed first send stays pending and the catch-up step resends it", async () => {
    ports.fail.donor = true;
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails(), isInKind: true, donor: { self: true } });
    expect(await donorSync(r.id)).toBe("pending");
    ports.fail.donor = false;
    expect(await resendDonorSync()).toEqual({ resent: 1, failed: 0 });
    expect(await donorSync(r.id)).toBe("synced");
    expect(ports.calls.donors).toHaveLength(3);
  });

  it("clearing the mark sends withdrawInKind and drops the donor names", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: badMath(), isInKind: true, donor: { self: true } });
    expect(r.state).toBe("validation_failed");
    await receiptService.setInKind(r.id, { isInKind: false });
    expect(ports.calls.withdrawals).toEqual([{ orgId: TEST_ORG_ID, receiptId: r.id, seq: 1 }]);
    const row = await db.receipt.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ isInKind: false, donorFirstName: null, donorSync: "synced" });
  });

  it("refuses the mark on a receipt already in QuickBooks", async () => {
    const { results } = await importReceipts([
      {
        importSourceId: "held-open",
        qbTxnId: "qb-1",
        retailer: "Old Store",
        receiptDate: "2023-03-01",
        shippingCents: 0,
        taxCents: 0,
        discountCents: 0,
        receiptTotalCents: 900,
        mimeType: "text/plain",
        fileBase64: Buffer.from("held open").toString("base64"),
        lineItems: [{ lineNumber: 1, description: "Old thing", quantity: 1, unitPriceCents: 500, totalPriceCents: 500, isDelayed: false }],
      },
    ]);
    const id = results[0].id as string;
    expect(results[0].state).toBe("validation_failed");

    await expect(receiptService.setInKind(id, { isInKind: true, donor: { self: true } })).rejects.toMatchObject({
      status: 400,
      message: "This receipt is already in QuickBooks, so it can't be marked as a donation",
    });
    expect(await db.receipt.findUniqueOrThrow({ where: { id } })).toMatchObject({ isInKind: false, donorSync: "none" });
    expect(ports.calls.donors).toEqual([]);
  });

  it("a never-in-kind receipt never sends withdrawInKind", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: badMath() });
    await receiptService.setInKind(r.id, { isInKind: false });
    await resendDonorSync();
    expect(ports.calls.withdrawals).toEqual([]);
    expect(await donorSync(r.id)).toBe("none");
  });

  it("a donor edited while the send is in flight is sent again, last write wins", async () => {
    let edits = 1;
    configure({
      receiptSink: ports.receiptSink,
      donorSink: {
        ...ports.donorSink,
        recordInKindDonor: async (orgId, receiptId, donor, seq) => {
          ports.calls.donors.push({ orgId, receiptId, donor, seq });
          if (edits-- > 0) await db.receipt.update({ where: { id: receiptId }, data: { donorFirstName: "Edited" } });
        },
      },
    });
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails(), isInKind: true, donor: { self: true } });
    expect(ports.calls.donors.map((c) => c.donor.firstName)).toEqual([ALICE.firstName, "Edited"]);
    expect(await donorSync(r.id)).toBe("synced");
  });

  it("a donor that keeps changing mid-send stops after 3 tries and stays pending", async () => {
    let n = 0;
    configure({
      receiptSink: ports.receiptSink,
      donorSink: {
        ...ports.donorSink,
        recordInKindDonor: async (orgId, receiptId, donor, seq) => {
          ports.calls.donors.push({ orgId, receiptId, donor, seq });
          await db.receipt.update({ where: { id: receiptId }, data: { donorFirstName: `Edit${++n}` } });
        },
      },
    });
    const r = await receiptService.upload(textFile(), "text/plain", { details: badMath(), isInKind: true, donor: { self: true } });
    expect(ports.calls.donors).toHaveLength(3);
    expect(await donorSync(r.id)).toBe("pending");
  });

  it("the mark change is audited without donor names", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: badMath() });
    await receiptService.setInKind(r.id, { isInKind: true, donor: { firstName: "Dana", lastName: "Donor" } });
    const rows = await db.receiptAuditLog.findMany({ where: { receiptId: r.id } });
    expect(rows.find((a) => a.action === "in_kind_updated")).toMatchObject({ valueBefore: "false", valueAfter: "true" });
    expect(JSON.stringify(rows)).not.toContain("Dana");
  });
});

describeDb("stale donor sends (in-kind findings K2–K4)", () => {
  it("a send held across a donor edit carries the older seq, and the edit's send the newer", async () => {
    ports.fail.donor = true;
    const r = await receiptService.upload(textFile(), "text/plain", { details: badMath(), isInKind: true, donor: { self: true } });
    ports.fail.donor = false;
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const sent: Array<{ firstName: string; seq: number }> = [];
    configure({
      receiptSink: ports.receiptSink,
      donorSink: {
        ...ports.donorSink,
        recordInKindDonor: async (_orgId, _receiptId, donor, seq) => {
          sent.push({ firstName: donor.firstName, seq });
          if (sent.length === 1) await held;
        },
      },
    });
    const senderA = resendDonorSync();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await receiptService.setInKind(r.id, { isInKind: true, donor: { firstName: "Dana", lastName: "Donor" } });
    release();
    await senderA;
    expect(sent).toEqual([
      { firstName: ALICE.firstName, seq: 0 },
      { firstName: "Dana", seq: 1 },
    ]);
    expect(await donorSync(r.id)).toBe("synced");
  });

  it("a finalized receipt is not delivered while its donor sync is pending", async () => {
    ports.fail.donor = true;
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails(), isInKind: true, donor: { self: true } });
    expect(ports.calls.pushes).toEqual([]);
    expect(await db.receipt.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ donorSync: "pending", pushedAt: null });
    expect(await db.receiptAuditLog.count({ where: { receiptId: r.id, action: "push_deferred" } })).toBe(1);

    ports.fail.donor = false;
    expect(await repushUnpushed()).toMatchObject({ pushed: 1 });
    expect(await donorSync(r.id)).toBe("synced");
    expect(ports.calls.pushes).toHaveLength(1);
  });

  it("a mark change whose state check passed before the receipt was finalized is refused", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: badMath(), isInKind: true, donor: { self: true } });
    const find = receiptRepo.find.bind(receiptRepo);
    vi.spyOn(receiptRepo, "find").mockImplementationOnce(async (id, orgId, uploadedByUserId) => {
      const row = await find(id, orgId, uploadedByUserId);
      await db.receiptDetail.update({ where: { id: r.id }, data: { state: "receipt_finalized" } });
      return row;
    });
    await expect(receiptService.setInKind(r.id, { isInKind: false })).rejects.toMatchObject({ status: 400 });
    expect(await db.receipt.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ isInKind: true, donorSync: "synced" });
    expect(ports.calls.withdrawals).toEqual([]);
  });
});
