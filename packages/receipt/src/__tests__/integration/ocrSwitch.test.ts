import { beforeEach, expect, it, vi } from "vitest";
import { db } from "../../db";
import { intakeMailedReceipt, receiptService } from "../../services/receiptService";
import { orgSettingsService } from "../../services/orgSettingsService";
import { OCR_OFF_NOTE } from "../../lib/ocrOff";
import { describeDb } from "../helpers/db";
import { ALICE, FINANCE, actAs, clearAll, configure, failingOcr, okOcr, recordingPorts, stateOf, textFile } from "../helpers/setup";

function withOcr(ocr = okOcr()) {
  const extract = vi.fn(ocr.extract);
  configure({ receiptSink: recordingPorts().receiptSink, ocr: { extract } });
  return extract;
}

async function turnOcrOff() {
  actAs(FINANCE);
  await orgSettingsService.update({ ocrEnabled: false });
  actAs(ALICE);
}

const ocrCalls = () => db.receiptAuditLog.count({ where: { action: "ocr_call" } });

beforeEach(async () => {
  await clearAll();
});

describeDb("automatic reading switch", () => {
  it("is on by default", async () => {
    actAs(FINANCE);
    expect(await orgSettingsService.get()).toMatchObject({ ocrEnabled: true });
  });

  it("while off, an upload calls no model, reserves no call and goes to manual entry with the note", async () => {
    const extract = withOcr();
    await turnOcrOff();
    const r = await receiptService.upload(textFile(), "text/plain", {});
    expect(r.state).toBe("ocr_failed");
    expect(r.validationNotes).toBe(OCR_OFF_NOTE);
    expect(extract).not.toHaveBeenCalled();
    expect(await ocrCalls()).toBe(0);
  });

  it("while off, retry refuses with 503 and calls no model", async () => {
    const extract = withOcr(failingOcr("data"));
    const failed = await receiptService.upload(textFile(), "text/plain", {});
    expect(extract).toHaveBeenCalledTimes(1);
    await turnOcrOff();
    await expect(receiptService.retryOcr(failed.id, "submitter")).rejects.toMatchObject({ status: 503, message: OCR_OFF_NOTE });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(await ocrCalls()).toBe(1);
    expect(await stateOf(failed.id)).toBe("ocr_failed");
  });

  it("while off, a mailed receipt calls no model and waits for its sender to type the details", async () => {
    const extract = withOcr();
    await turnOcrOff();
    const id = await intakeMailedReceipt(ALICE, textFile(), "text/plain", async () => undefined);
    expect(await stateOf(id)).toBe("ocr_failed");
    expect(extract).not.toHaveBeenCalled();
    expect(await ocrCalls()).toBe(0);
  });

  it("turned back on, reading works again", async () => {
    const extract = withOcr();
    await turnOcrOff();
    actAs(FINANCE);
    await orgSettingsService.update({ ocrEnabled: true });
    actAs(ALICE);
    const r = await receiptService.upload(textFile(), "text/plain", {});
    expect(r.state).not.toBe("ocr_failed");
    expect(extract).toHaveBeenCalledTimes(1);
  });
});
