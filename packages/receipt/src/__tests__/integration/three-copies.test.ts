import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { ALICE, FINANCE, actAs, clearAll, configure, manualDetails, okOcr, recordingPorts, stateOf, textFile } from "../helpers/setup";

// Three receipts for one purchase, A uploaded first, then B, then C. Each test drives finance's
// decisions through the service and records where the copies land.

let ports: ReturnType<typeof recordingPorts>;

beforeEach(async () => {
  await clearAll();
  ports = recordingPorts();
  configure({ receiptSink: ports.receiptSink, ocr: okOcr() });
});

async function suspectOf(id: string): Promise<string | null | undefined> {
  return (await db.receiptDetail.findUnique({ where: { id } }))?.duplicateSuspectReceiptId;
}

const upload = (file: Buffer) => receiptService.upload(file, "text/plain", { details: manualDetails() });

/** A finalized original and two flagged copies of the same file. */
async function sameFileThrice() {
  const file = textFile();
  const a = await upload(file);
  const b = await upload(file);
  const c = await upload(file);
  return { a, b, c };
}

describeDb("three copies of one purchase", () => {
  it("matched by file hash, both later copies are flagged against the first upload", async () => {
    const { a, b, c } = await sameFileThrice();
    expect(a.state).toBe("receipt_finalized");
    expect([b.state, c.state]).toEqual(["duplicate_flagged", "duplicate_flagged"]);
    expect(await suspectOf(b.id)).toBe(a.id);
    expect(await suspectOf(c.id)).toBe(a.id);
  });

  it("matched by retailer, date and total, the third copy is flagged against one earlier copy, A or B", async () => {
    const a = await upload(textFile());
    const b = await upload(textFile());
    const c = await upload(textFile());
    expect(await suspectOf(b.id)).toBe(a.id);
    expect(await stateOf(c.id)).toBe("duplicate_flagged");
    expect([a.id, b.id]).toContain(await suspectOf(c.id));
  });

  it("a third copy cleared against the original goes through though it matches an already-cleared copy", async () => {
    const { a, b, c } = await sameFileThrice();
    actAs(FINANCE);
    await receiptService.clearDuplicate(b.id);
    expect(await stateOf(b.id)).toBe("receipt_finalized");

    expect(await stateOf(c.id)).toBe("duplicate_flagged");
    expect(await suspectOf(c.id)).toBe(a.id);
    await receiptService.clearDuplicate(c.id);

    expect([await stateOf(a.id), await stateOf(b.id), await stateOf(c.id)]).toEqual([
      "receipt_finalized",
      "receipt_finalized",
      "receipt_finalized",
    ]);
    expect(ports.calls.pushes.map((p) => p.receiptId).sort()).toEqual([a.id, b.id, c.id].sort());
  });

  it("matched by fields, two cleared copies both go through and neither is compared with the other", async () => {
    const a = await upload(textFile());
    const b = await upload(textFile());
    const c = await upload(textFile());
    actAs(FINANCE);
    await receiptService.clearDuplicate(b.id);
    await receiptService.clearDuplicate(c.id);
    expect([await stateOf(a.id), await stateOf(b.id), await stateOf(c.id)]).toEqual([
      "receipt_finalized",
      "receipt_finalized",
      "receipt_finalized",
    ]);
  });

  it("after its uploader discards the original to keep B, C stays flagged against the discarded original and clears through beside B", async () => {
    const file = textFile();
    const a = await receiptService.upload(file, "text/plain", {});
    expect(a.state).toBe("submitter_review");
    const b = await upload(file);
    const c = await upload(file);
    expect(await suspectOf(b.id)).toBe(a.id);
    expect(await suspectOf(c.id)).toBe(a.id);

    await receiptService.discard(a.id, "submitter");
    actAs(FINANCE);
    await receiptService.clearDuplicate(b.id);
    expect(await stateOf(b.id)).toBe("receipt_finalized");

    expect(await stateOf(c.id)).toBe("duplicate_flagged");
    expect(await suspectOf(c.id)).toBe(a.id);
    expect(await stateOf(a.id)).toBe("discarded");
    await receiptService.clearDuplicate(c.id);

    expect([await stateOf(b.id), await stateOf(c.id)]).toEqual(["receipt_finalized", "receipt_finalized"]);
  });

  it("copies uploaded after the original was discarded are flagged against it, and both clear through", async () => {
    const file = textFile();
    const a = await receiptService.upload(file, "text/plain", {});
    await receiptService.submitterDiscard(a.id);
    expect(await stateOf(a.id)).toBe("discarded");

    const b = await upload(file);
    const c = await upload(file);
    expect(await suspectOf(b.id)).toBe(a.id);
    expect(await suspectOf(c.id)).toBe(a.id);

    actAs(FINANCE);
    await receiptService.clearDuplicate(b.id);
    await receiptService.clearDuplicate(c.id);
    expect([await stateOf(b.id), await stateOf(c.id)]).toEqual(["receipt_finalized", "receipt_finalized"]);
  });

  it("copies of a rejected receipt are flagged against it, and both clear through", async () => {
    const file = textFile();
    const a = await receiptService.upload(file, "text/plain", { details: manualDetails({ receiptDate: "2999-01-01" }) });
    expect(a.state).toBe("financial_review");
    actAs(FINANCE);
    await receiptService.rejectFinancial(a.id, "personal purchase");
    expect(await stateOf(a.id)).toBe("rejected");

    actAs(ALICE);
    const b = await upload(file);
    const c = await upload(file);
    expect(await suspectOf(b.id)).toBe(a.id);
    expect(await suspectOf(c.id)).toBe(a.id);

    actAs(FINANCE);
    await receiptService.clearDuplicate(b.id);
    await receiptService.clearDuplicate(c.id);
    expect([await stateOf(b.id), await stateOf(c.id)]).toEqual(["receipt_finalized", "receipt_finalized"]);
  });

  /** A finalized original A, a second file B of the same purchase, and C a re-upload of B's file. */
  async function chainedThroughB() {
    const a = await upload(textFile());
    const scan = textFile();
    const b = await upload(scan);
    const c = await upload(scan);
    return { a, b, c };
  }

  it("a re-upload of a copy's file is flagged against that copy, not the original", async () => {
    const { a, b, c } = await chainedThroughB();
    expect(a.state).toBe("receipt_finalized");
    expect(await suspectOf(b.id)).toBe(a.id);
    expect(await suspectOf(c.id)).toBe(b.id);
  });

  it("when the copy C points at is discarded by its uploader, C stays flagged against the discarded copy and clears through beside the original", async () => {
    const { a, b, c } = await chainedThroughB();
    await receiptService.discard(b.id, "submitter");
    actAs(FINANCE);

    expect(await stateOf(c.id)).toBe("duplicate_flagged");
    expect(await suspectOf(c.id)).toBe(b.id);
    await receiptService.clearDuplicate(c.id);

    expect([await stateOf(a.id), await stateOf(b.id), await stateOf(c.id)]).toEqual([
      "receipt_finalized",
      "discarded",
      "receipt_finalized",
    ]);
  });

  it("when the copy C points at is cleared, C stays flagged against that now-finalized copy", async () => {
    const { b, c } = await chainedThroughB();
    actAs(FINANCE);
    await receiptService.clearDuplicate(b.id);

    expect(await stateOf(b.id)).toBe("receipt_finalized");
    expect(await stateOf(c.id)).toBe("duplicate_flagged");
    expect(await suspectOf(c.id)).toBe(b.id);
  });
});
