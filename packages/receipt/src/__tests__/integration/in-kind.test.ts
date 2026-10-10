import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { resendDonorSync } from "../../services/catchUp";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { ALICE, TEST_ORG_ID, clearAll, configure, manualDetails, recordingPorts, textFile } from "../helpers/setup";

let ports: ReturnType<typeof recordingPorts>;

beforeEach(async () => {
  await clearAll();
  ports = recordingPorts();
  configure({ receiptSink: ports.receiptSink, donorSink: ports.donorSink });
});

const donorSync = async (id: string) => (await db.receipt.findUniqueOrThrow({ where: { id } })).donorSync;
const badMath = () => manualDetails({ receiptTotal: "1" });

describeDb("in-kind mark and donor (X13)", () => {
  it("requires a donor and forbids reimbursement", async () => {
    await expect(receiptService.upload(textFile(), "text/plain", { details: manualDetails(), isInKind: true })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      receiptService.upload(textFile(), "text/plain", {
        details: manualDetails(),
        isInKind: true,
        donor: { self: true },
        needsReimbursement: true,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("'I am the donor' sends the uploader's names; the push carries only isInKind", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails(), isInKind: true, donor: { self: true } });
    expect(ports.calls.donors).toEqual([
      { orgId: TEST_ORG_ID, receiptId: r.id, donor: { firstName: ALICE.firstName, lastName: ALICE.lastName, companyName: null } },
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
    expect(ports.calls.donors).toHaveLength(2);
  });

  it("clearing the mark sends withdrawInKind and drops the donor names", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: badMath(), isInKind: true, donor: { self: true } });
    expect(r.state).toBe("validation_failed");
    await receiptService.setInKind(r.id, { isInKind: false });
    expect(ports.calls.withdrawals).toEqual([{ orgId: TEST_ORG_ID, receiptId: r.id }]);
    const row = await db.receipt.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ isInKind: false, donorFirstName: null, donorSync: "synced" });
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
        recordInKindDonor: async (orgId, receiptId, donor) => {
          ports.calls.donors.push({ orgId, receiptId, donor });
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
        recordInKindDonor: async (orgId, receiptId, donor) => {
          ports.calls.donors.push({ orgId, receiptId, donor });
          await db.receipt.update({ where: { id: receiptId }, data: { donorFirstName: `Edit${++n}` } });
        },
      },
    });
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails(), isInKind: true, donor: { self: true } });
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
