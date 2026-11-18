import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { ALICE, BOB, FINANCE, actAs, clearAll, configure, failingOcr, manualDetails, okOcr, recordingPorts, textFile } from "../helpers/setup";

beforeEach(async () => {
  await clearAll();
  const ports = recordingPorts();
  configure({ receiptSink: ports.receiptSink, donorSink: ports.donorSink });
  actAs(ALICE);
});

const stored = async (id: string) => db.receipt.findUniqueOrThrow({ where: { id }, include: { details: true } });

describeDb("receipt image rotation", () => {
  it("saves each of the four turns and audits each change", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    for (const rotation of [90, 180, 270, 0]) {
      expect(await receiptService.setRotation(r.id, { rotation }, "submitter")).toEqual({ id: r.id, rotation });
      expect((await stored(r.id)).rotation).toBe(rotation);
    }
    const audits = await db.receiptAuditLog.findMany({ where: { receiptId: r.id, action: "file_rotated" }, orderBy: { id: "asc" } });
    expect(audits.map((a) => [a.valueBefore, a.valueAfter])).toEqual([["0", "90"], ["90", "180"], ["180", "270"], ["270", "0"]]);
  });

  it("refuses a value outside 0, 90, 180 and 270", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    for (const rotation of [45, -90, 360, "90", null]) {
      await expect(receiptService.setRotation(r.id, { rotation }, "submitter")).rejects.toMatchObject({ status: 400 });
    }
    expect((await stored(r.id)).rotation).toBe(0);
  });

  it("leaves the receipt's details and review state alone", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    const before = await stored(r.id);
    actAs(FINANCE);
    await receiptService.setRotation(r.id, { rotation: 270 }, "finance");
    const after = await stored(r.id);
    expect(after.details).toEqual(before.details);
    expect({ ...after, rotation: 0 }).toEqual(before);
  });

  it("reads the receipt again turned as it was saved", async () => {
    const ports = recordingPorts();
    configure({ receiptSink: ports.receiptSink, donorSink: ports.donorSink, ocr: failingOcr("data") });
    const r = await receiptService.upload(textFile(), "text/plain", {});
    await receiptService.setRotation(r.id, { rotation: 270 }, "submitter");
    const turns: (number | undefined)[] = [];
    const ocr = okOcr();
    configure({ receiptSink: ports.receiptSink, donorSink: ports.donorSink, ocr: { extract: (f, m, rotation) => (turns.push(rotation), ocr.extract(f, m)) } });
    await receiptService.retryOcr(r.id, "submitter");
    expect(turns).toEqual([270]);
  });

  it("refuses a submitter rotating someone else's receipt", async () => {
    const r = await receiptService.upload(textFile(), "text/plain", { details: manualDetails() });
    actAs(BOB);
    await expect(receiptService.setRotation(r.id, { rotation: 90 }, "submitter")).rejects.toMatchObject({ status: 404 });
    expect((await stored(r.id)).rotation).toBe(0);
  });
});
