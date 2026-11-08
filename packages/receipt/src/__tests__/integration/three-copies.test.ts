import { beforeEach, expect, it } from "vitest";
import type { DuplicateMember } from "../../lib/duplicateGroup";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { ALICE, BOB, FINANCE, actAs, clearAll, configure, manualDetails, okOcr, recordingPorts, stateOf, textFile } from "../helpers/setup";

// Three receipts for one purchase, A uploaded first, then B, then C. Each test drives finance's
// decisions through the service and asserts the group behaviour of 2516_RECEIPT_DUPLICATES.md.

let ports: ReturnType<typeof recordingPorts>;

beforeEach(async () => {
  await clearAll();
  ports = recordingPorts();
  configure({ receiptSink: ports.receiptSink, ocr: okOcr() });
});

const upload = (file: Buffer) => receiptService.upload(file, "text/plain", { details: manualDetails() });
/** An OCR'd upload with no typed details, which waits in submitter review. */
const uploadForReview = (file: Buffer) => receiptService.upload(file, "text/plain", {});

async function groupOf(id: string): Promise<string[]> {
  return (await receiptService.duplicateGroup(id)).members.map((m) => m.id);
}

async function memberOf(viewed: string, id: string): Promise<DuplicateMember | undefined> {
  return (await receiptService.duplicateGroup(viewed)).members.find((m) => m.id === id);
}

async function statesOf(...ids: string[]): Promise<Array<string | undefined>> {
  return Promise.all(ids.map(stateOf));
}

/** A finalized original and two flagged copies of the same file. */
async function sameFileThrice() {
  const file = textFile();
  const a = await upload(file);
  const b = await upload(file);
  const c = await upload(file);
  return { a, b, c };
}

/** An original waiting in submitter review, and two flagged copies of its file. */
async function openOriginalAndTwoCopies() {
  const file = textFile();
  const a = await uploadForReview(file);
  const b = await upload(file);
  const c = await upload(file);
  return { a, b, c };
}

/** A finalized original A, a second file B of the same purchase, and C a re-upload of B's file. */
async function chainedThroughB() {
  const a = await upload(textFile());
  const scan = textFile();
  const b = await upload(scan);
  const c = await upload(scan);
  return { a, b, c };
}

describeDb("three copies of one purchase", () => {
  it("matched by file hash, both later copies are held in one group of all three, in upload order", async () => {
    const { a, b, c } = await sameFileThrice();
    expect(a.state).toBe("receipt_finalized");
    expect(await statesOf(b.id, c.id)).toEqual(["duplicate_flagged", "duplicate_flagged"]);
    expect(await groupOf(b.id)).toEqual([a.id, b.id, c.id]);
    expect(await groupOf(c.id)).toEqual([a.id, b.id, c.id]);
  });

  it("matched by retailer, date and total, the third copy's group holds both earlier copies, always in upload order", async () => {
    const a = await upload(textFile());
    const b = await upload(textFile());
    const c = await upload(textFile());
    expect(await stateOf(c.id)).toBe("duplicate_flagged");
    expect(await groupOf(c.id)).toEqual([a.id, b.id, c.id]);
  });

  it("a third copy shows the copy already dismissed against the original, and clearing it decides both pairs", async () => {
    const { a, b, c } = await sameFileThrice();
    actAs(FINANCE);
    await receiptService.notThisOne(b.id, a.id);
    expect(await stateOf(b.id)).toBe("duplicate_flagged");

    expect(await groupOf(c.id)).toEqual([a.id, b.id, c.id]);
    await receiptService.differentPurchases(c.id, [a.id, b.id, c.id]);

    expect((await receiptService.duplicateGroup(c.id)).dismissed.sort()).toEqual([a.id, b.id].sort());
    expect(await statesOf(a.id, b.id, c.id)).toEqual(["receipt_finalized", "receipt_finalized", "receipt_finalized"]);
    expect(ports.calls.pushes.map((p) => p.receiptId).sort()).toEqual([a.id, b.id, c.id].sort());
  });

  it("matched by fields, each copy's group holds the other until a decision covers that pair", async () => {
    const a = await upload(textFile());
    const b = await upload(textFile());
    const c = await upload(textFile());
    expect(await groupOf(b.id)).toContain(c.id);
    expect(await groupOf(c.id)).toContain(b.id);

    actAs(FINANCE);
    await receiptService.notThisOne(b.id, c.id);
    expect(await groupOf(b.id)).toEqual([a.id, b.id]);
    expect(await groupOf(c.id)).toEqual([a.id, c.id]);
    expect(await statesOf(b.id, c.id)).toEqual(["duplicate_flagged", "duplicate_flagged"]);
  });

  it("keeping B rejects the open original as a copy of B, and a later copy C is held against live B", async () => {
    const file = textFile();
    const a = await uploadForReview(file);
    expect(a.state).toBe("submitter_review");
    const b = await upload(file);
    expect(await groupOf(b.id)).toEqual([a.id, b.id]);

    actAs(FINANCE);
    await receiptService.keepThisOne(b.id, [a.id, b.id]);
    expect(await statesOf(a.id, b.id)).toEqual(["rejected", "receipt_finalized"]);

    actAs(ALICE);
    const c = await upload(file);
    expect(c.state).toBe("duplicate_flagged");
    expect(await groupOf(c.id)).toEqual([a.id, b.id, c.id]);
    expect((await memberOf(c.id, a.id))?.label).toMatch(/^Rejected as a copy of /);

    actAs(FINANCE);
    await receiptService.notThisOne(c.id, a.id);
    expect(await stateOf(c.id)).toBe("duplicate_flagged");
  });

  it("an original withdrawn by its submitter raises no flag, so only the second copy is held, against the first", async () => {
    const file = textFile();
    const a = await uploadForReview(file);
    await receiptService.submitterDiscard(a.id);
    expect(await stateOf(a.id)).toBe("discarded");

    const b = await upload(file);
    expect(b.state).toBe("receipt_finalized");
    const c = await upload(file);
    expect(c.state).toBe("duplicate_flagged");
    expect(await groupOf(c.id)).toEqual([a.id, b.id, c.id]);
    expect(await memberOf(c.id, a.id)).toMatchObject({ state: "discarded", label: expect.stringMatching(/^Withdrawn by its submitter/) });
  });

  it("copies of a rejected receipt are held in one group with it, labelled rejected with its reason", async () => {
    const file = textFile();
    const a = await receiptService.upload(file, "text/plain", { details: manualDetails({ receiptDate: "2999-01-01" }) });
    expect(a.state).toBe("financial_review");
    actAs(FINANCE);
    await receiptService.rejectFinancial(a.id, "personal purchase");
    expect(await stateOf(a.id)).toBe("rejected");

    actAs(ALICE);
    const b = await upload(file);
    const c = await upload(file);
    expect(await statesOf(b.id, c.id)).toEqual(["duplicate_flagged", "duplicate_flagged"]);
    expect(await groupOf(b.id)).toEqual([a.id, b.id, c.id]);
    expect((await memberOf(b.id, a.id))?.label).toMatch(/^Rejected .*personal purchase/);
  });

  it("a re-upload of a copy's file is grouped with that copy and the original", async () => {
    const { a, b, c } = await chainedThroughB();
    expect(a.state).toBe("receipt_finalized");
    expect(await groupOf(c.id)).toEqual([a.id, b.id, c.id]);
  });

  it("when the copy C re-uploads is rejected as a copy of A, C stays held against live A", async () => {
    const { a, b, c } = await chainedThroughB();
    actAs(FINANCE);
    await receiptService.rejectFinancial(b.id, `Copy of ${a.id}`);
    expect(await stateOf(b.id)).toBe("rejected");

    expect(await stateOf(c.id)).toBe("duplicate_flagged");
    expect(await memberOf(c.id, a.id)).toMatchObject({ state: "receipt_finalized" });
  });

  it("when B is dismissed against the original, C stays held in a group with A and B", async () => {
    const { a, b, c } = await chainedThroughB();
    actAs(FINANCE);
    await receiptService.notThisOne(b.id, a.id);

    expect(await statesOf(b.id, c.id)).toEqual(["duplicate_flagged", "duplicate_flagged"]);
    expect(await groupOf(c.id)).toEqual([a.id, b.id, c.id]);
  });
});

describeDb("every member is held before it can finalize", () => {
  it("an earlier open copy stays in review with a group, then meets the guard when its submitter confirms", async () => {
    const file = textFile();
    const a = await uploadForReview(file);
    const b = await upload(file);
    expect(await stateOf(a.id)).toBe("submitter_review");
    expect(await groupOf(a.id)).toEqual([a.id, b.id]);

    await receiptService.submitterConfirm(a.id);
    expect(await statesOf(a.id, b.id)).toEqual(["duplicate_flagged", "duplicate_flagged"]);
  });
});

describeDb("re-check after a discard", () => {
  it("a copy whose only match is withdrawn re-runs its pipeline and finalizes", async () => {
    const file = textFile();
    const a = await uploadForReview(file);
    const b = await upload(file);
    expect(b.state).toBe("duplicate_flagged");

    await receiptService.discard(a.id, "submitter");
    expect(await stateOf(b.id)).toBe("receipt_finalized");
  });

  it("a copy still matching another member stays held, and its group shows what is left", async () => {
    const file = textFile();
    const a = await uploadForReview(file);
    const b = await upload(file);
    const c = await upload(textFile());
    expect(c.state).toBe("duplicate_flagged");

    await receiptService.discard(a.id, "submitter");
    expect(await statesOf(b.id, c.id)).toEqual(["duplicate_flagged", "duplicate_flagged"]);
    expect(await groupOf(b.id)).toEqual([a.id, b.id, c.id]);
    expect(await memberOf(b.id, a.id)).toMatchObject({ state: "discarded" });
  });
});

describeDb("when the group changes after the panel was drawn", () => {
  it("a copy arriving after the panel was drawn stays held after Different purchases on the old ids", async () => {
    const a = await upload(textFile());
    const b = await upload(textFile());
    const shown = await groupOf(b.id);
    expect(shown).toEqual([a.id, b.id]);

    const c = await upload(textFile());
    actAs(FINANCE);
    await expect(receiptService.differentPurchases(b.id, shown)).rejects.toMatchObject({ status: 409 });

    expect(await statesOf(b.id, c.id)).toEqual(["duplicate_flagged", "duplicate_flagged"]);
    expect(await groupOf(c.id)).toEqual([a.id, b.id, c.id]);
  });

  it("a group-wide action on a stale set of ids writes nothing and answers 409", async () => {
    const { a, b, c } = await openOriginalAndTwoCopies();
    const shown = await groupOf(b.id);
    expect(shown).toEqual([a.id, b.id, c.id]);

    await receiptService.discard(c.id, "submitter");
    actAs(FINANCE);
    await expect(receiptService.keepThisOne(b.id, shown)).rejects.toMatchObject({ status: 409 });

    expect(await statesOf(a.id, b.id, c.id)).toEqual(["submitter_review", "duplicate_flagged", "discarded"]);
    expect((await receiptService.duplicateGroup(b.id)).dismissed).toEqual([]);
  });

  it("two finance decisions on one group at once: one wins, the other answers 409 and writes nothing", async () => {
    const { a, b, c } = await openOriginalAndTwoCopies();
    const shown = await groupOf(b.id);

    actAs(FINANCE);
    const [keep, different] = await Promise.allSettled([
      receiptService.keepThisOne(b.id, shown),
      receiptService.differentPurchases(c.id, shown),
    ]);
    expect([keep.status, different.status].sort()).toEqual(["fulfilled", "rejected"]);
    const loser = keep.status === "rejected" ? keep : different;
    expect(loser).toMatchObject({ reason: { status: 409 } });

    const states = await statesOf(a.id, b.id, c.id);
    if (keep.status === "fulfilled") {
      expect(states).toEqual(["rejected", "receipt_finalized", "rejected"]);
      expect((await receiptService.duplicateGroup(b.id)).dismissed).toEqual([]);
    } else {
      expect(states).not.toContain("rejected");
      expect((await receiptService.duplicateGroup(c.id)).dismissed.sort()).toEqual([a.id, b.id].sort());
    }
  });
});

describeDb("what finance reads about a group", () => {
  it("the queue has one row per group, and the tab and the pill both count groups", async () => {
    const { a, b, c } = await sameFileThrice();
    const otherPurchase = { details: manualDetails({ retailer: "Other Store" }) };
    await receiptService.upload(textFile(), "text/plain", otherPurchase);
    await receiptService.upload(textFile(), "text/plain", otherPurchase);

    actAs(FINANCE);
    const rows = await receiptService.duplicateQueue();
    const row = rows.find((r) => r.id === b.id);
    expect(row).toMatchObject({ memberCount: 3, includesRejected: false });
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.id === c.id || r.id === a.id)).toBe(false);
    const { byState } = await receiptService.queueCounts(null);
    expect(byState.duplicate_flagged).toBe(rows.length);
    expect((await receiptService.countAwaitingFinance(FINANCE.id)).byState.duplicate_flagged).toBe(rows.length);
  });

  it("a queue row says when its group includes a rejected receipt", async () => {
    const file = textFile();
    const a = await receiptService.upload(file, "text/plain", { details: manualDetails({ receiptDate: "2999-01-01" }) });
    actAs(FINANCE);
    await receiptService.rejectFinancial(a.id, "personal purchase");
    actAs(ALICE);
    const b = await upload(file);
    actAs(FINANCE);
    expect(await receiptService.duplicateQueue()).toEqual([expect.objectContaining({ id: b.id, memberCount: 2, includesRejected: true })]);
  });

  it("the org list names the receipt kept in place of one rejected as a copy", async () => {
    const file = textFile();
    const a = await uploadForReview(file);
    const b = await upload(file);
    actAs(FINANCE);
    await receiptService.keepThisOne(b.id, [a.id, b.id]);
    const row = (await receiptService.list({})).find((r) => r.id === a.id);
    expect(row).toMatchObject({ copyOfId: b.id, copyOfLabel: expect.stringMatching(/, uploaded /) });
  });

  it("labels a finalized member whose expense finance rejected, and names each uploader", async () => {
    const { a, b } = await sameFileThrice();
    configure({
      receiptSink: ports.receiptSink,
      ocr: okOcr(),
      purchaseOutcomes: { forReceipts: async () => new Map([[a.id, { receiving: null, money: { status: "line_rejected" as const, notes: ["personal purchase"] }, gift: null }]]) },
      personNames: { namesOf: async (ids) => new Map(ids.map((id) => [id, `Person ${id}`])) },
    });
    actAs(FINANCE);
    const member = (await receiptService.duplicateGroup(b.id)).members.find((m) => m.id === a.id);
    expect(member?.label).toBe("Finalized · expense rejected by finance: personal purchase");
    expect(member?.uploaderName).toBe(`Person ${ALICE.id}`);
  });

  it("tells an uploader about their own copy, and nothing when the only match is someone else's", async () => {
    const file = textFile();
    const a = await uploadForReview(file);
    const b = await upload(file);
    expect((await receiptService.get(b.id, "submitter")).duplicateNotice).toMatchObject({ matchId: a.id });

    const purchase = { details: manualDetails({ retailer: "Other Store" }) };
    actAs(BOB);
    await receiptService.upload(textFile(), "text/plain", purchase);
    actAs(ALICE);
    const mine = await receiptService.upload(textFile(), "text/plain", purchase);
    expect(mine.state).toBe("duplicate_flagged");
    expect((await receiptService.get(mine.id, "submitter")).duplicateNotice).toBeNull();
  });
});
