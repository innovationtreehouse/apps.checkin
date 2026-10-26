/**
 * The in-kind drain: an accepted gift that waits on nothing but booking becomes one QuickBooks
 * JournalEntry, through the real QuickBooksClient over an in-memory company, unless finance's
 * clearing-account pair is found first. Nothing books on or before the books closing date.
 */
import { it, expect, beforeEach } from "vitest";
import { QuickBooksClient, appKeyOf, type BooksMapRole, type QboDeposit, type QboJournalEntry, type QboPurchase } from "@checkin/quickbooks";
import type { CompletedReceipt } from "@checkin/receipt-types";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { configureBulkDonation } from "../../runtime";
import { ingestInKind, recordInKindDonor } from "../../inKind";
import { inKindAcceptService, type InKindDecisionInput } from "../../services/inKindAcceptService";
import { inKindKey, inKindPostingOnAt, runInKindQbPosting } from "../../lib/in-kind-poster";
import type { InKindCapital, OwnerInfo } from "../../contract";
import { TEST_ORG_ID } from "../helpers/factories";

const orgId = TEST_ORG_ID;
const FINANCE = 10;
const UPLOADER = 7;
const ACCOUNTS: Partial<Record<BooksMapRole, string>> = { INKIND_INCOME: "400", INKIND_EXPENSE: "600", FIXED_ASSETS: "150", INKIND_CLEARING: "290", BENEVITY_BANK: "35" };
const BUCKETS: OwnerInfo[] = [{ id: 1, name: "Robotics", archivedAt: null, quickBooksClassId: "C1" }];
const ACCEPT: InKindDecisionInput = { outcome: "accept", bucketId: 1, confirmOutsideDonorHousehold: true };

interface PostedJournal {
  TxnDate: string;
  Line: { Amount: number; JournalEntryLineDetail: { PostingType: string; AccountRef: { value: string }; ClassRef?: { value: string } }; Description?: string }[];
  PrivateNote: string;
}

/** Dated and created-since reads of JournalEntry, Deposit and Purchase, Preferences, and JournalEntry creates. */
class FakeQbo {
  journals: QboJournalEntry[] = [];
  deposits: QboDeposit[] = [];
  purchases: QboPurchase[] = [];
  posts: { key: string; body: PostedJournal }[] = [];
  closeDate: string | null = null;
  dropAfterCreate = false;
  createTimes = new Map<string, Date>();
  private nextId = 9000;

  handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { intuit_tid: "tid" } });
    if ((init?.method ?? "GET") === "GET") {
      const query = url.searchParams.get("query") ?? "";
      if (query === "SELECT * FROM Preferences") return json({ QueryResponse: { Preferences: [{ AccountingInfoPrefs: this.closeDate ? { BookCloseDate: this.closeDate } : {} }] } });
      const since = /FROM JournalEntry WHERE MetaData\.CreateTime >= '([^']+)'/.exec(query);
      if (since) {
        const list = this.journals.filter((j) => (this.createTimes.get(j.Id)?.getTime() ?? 0) >= Date.parse(since[1]));
        return json({ QueryResponse: list.length ? { JournalEntry: list } : {} });
      }
      const m = /FROM (JournalEntry|Deposit|Purchase) WHERE TxnDate >= '([\d-]+)' AND TxnDate <= '([\d-]+)'/.exec(query);
      if (!m) throw new Error(`unexpected query ${query}`);
      const all: { TxnDate: string }[] = m[1] === "JournalEntry" ? this.journals : m[1] === "Deposit" ? this.deposits : this.purchases;
      const list = all.filter((e) => e.TxnDate >= m[2] && e.TxnDate <= m[3]);
      return json({ QueryResponse: list.length ? { [m[1]]: list } : {} });
    }
    if (!url.pathname.endsWith("/journalentry")) throw new Error(`unexpected write ${url.pathname}`);
    const body = JSON.parse(String(init?.body)) as PostedJournal;
    this.posts.push({ key: url.searchParams.get("requestid") ?? "", body });
    const Id = String(this.nextId++);
    const TotalAmt = body.Line.filter((l) => l.JournalEntryLineDetail.PostingType === "Debit").reduce((s, l) => s + Math.round(l.Amount * 100), 0) / 100;
    this.journals.push({ Id, TxnDate: body.TxnDate, TotalAmt, PrivateNote: body.PrivateNote });
    this.createTimes.set(Id, new Date());
    if (this.dropAfterCreate) throw new Error("socket hang up");
    return json({ JournalEntry: { Id } });
  };
}

let qbo: FakeQbo;
let accounts: Partial<Record<BooksMapRole, string>>;
let awaiting: { giftSource: string; giftId: number }[];
let assets: number[];
let alerts: number;

function configure() {
  const client = new QuickBooksClient({ current: async () => "tok" }, { env: "sandbox", realmId: "123" });
  const capital: InKindCapital = { submit: async () => {}, awaitingReview: async () => awaiting, assetLineIds: async () => assets };
  configureBulkDonation({
    auth: { getPrincipal: async () => ({ id: FINANCE, name: "finance" }) },
    org: async () => ({ id: orgId, name: "Test Org" }),
    owners: { list: async () => BUCKETS },
    inKind: {
      financeHolders: async () => [FINANCE],
      boardMembers: async () => [],
      householdsOf: async (ids) => new Map(ids.map((id) => [id, [id]])),
      householdsSharingSurname: async (checks) => checks.map(() => false),
      bucketsApprovedBy: async () => [],
      largeValueCents: async () => 50_000,
    },
    capital,
    inKindQb: {
      client: async () => client,
      booksMap: { accounts: async () => accounts, classes: async () => new Map([[1, "77"]]) },
      sweepIncomplete: async () => void alerts++,
    },
  });
}

let receiptSeq = 0;
/** An accepted receipt gift: lines of 10.00 and 20.00 on a receipt totalling 33.00 with tax. */
async function acceptedGift(opts: { totalCents?: number; date?: string } = {}): Promise<number> {
  const receiptId = `33333333-3333-4333-8333-${String(++receiptSeq).padStart(12, "0")}`;
  const receipt: CompletedReceipt = {
    receiptId,
    orgId,
    submitterId: UPLOADER,
    vendorName: "Hardware Co",
    receiptNumber: null,
    orderNumber: null,
    currency: "USD",
    taxCents: 300,
    shippingCents: 0,
    discountCents: 0,
    receiptTotalCents: opts.totalCents ?? 3300,
    receiptDate: opts.date ?? "2026-10-20",
    needsReimbursement: false,
    reimbursementFor: null,
    submittedAt: "2026-10-20T12:00:00.000Z",
    backfill: false,
    isInKind: true,
    lineItems: [
      { receiptLineItemId: 1, lineNumber: 1, description: "Paper", partNumber: null, manufacturer: null, quantity: 1, unitPriceCents: 1000, totalPriceCents: 1000, isDelayed: false },
      { receiptLineItemId: 2, lineNumber: 2, description: "Lathe", partNumber: null, manufacturer: null, quantity: 1, unitPriceCents: 2000, totalPriceCents: 2000, isDelayed: false },
    ],
  };
  await ingestInKind(receipt);
  await recordInKindDonor(orgId, receiptId, { firstName: "Jane", lastName: "Doe", companyName: null }, 0);
  const { id } = await db.inKindDonation.findUniqueOrThrow({ where: { orgId_receiptId: { orgId, receiptId } } });
  await inKindAcceptService.decide("receipt", id, ACCEPT, { actorUserId: FINANCE, actorUsername: "finance" });
  return id;
}

const lineIds = async (id: number) => (await db.inKindDonationLine.findMany({ where: { donationId: id }, orderBy: { lineNumber: "asc" } })).map((l) => l.id);
const posting = (id: number) => db.inKindPosting.findUniqueOrThrow({ where: { orgId_source_giftId: { orgId, source: "receipt", giftId: id } } });
const bookings = (id: number) => db.inKindBooking.findMany({ where: { orgId, giftId: id }, orderBy: { side: "asc" } });
/** Switches the lane on with no gift waiting, so gifts recorded afterwards book on their own. */
const switchOn = async () => expect(await runInKindQbPosting(orgId, new Date(Date.now() - 60_000))).toMatchObject({ posted: 0 });

beforeEach(async () => {
  await db.workflowEvent.deleteMany({});
  await db.inKindDonation.deleteMany({});
  await db.manualInKindDonation.deleteMany({});
  await db.inKindSyncMark.deleteMany({});
  await db.inKindBooking.deleteMany({});
  await db.inKindPosting.deleteMany({});
  await db.donationOrgSettings.deleteMany({});
  qbo = new FakeQbo();
  // Finance's closing date; without one, nothing dated before today's switch-on could book.
  qbo.closeDate = "2026-06-30";
  globalThis.fetch = qbo.handle as typeof fetch;
  accounts = { ...ACCOUNTS };
  awaiting = [];
  assets = [];
  alerts = 0;
  configure();
});

describeDb("in-kind drain", () => {
  it("does nothing, and stays switched off, until every in-kind role is in the books map", async () => {
    delete accounts.FIXED_ASSETS;
    await expect(runInKindQbPosting(orgId)).resolves.toBe("unconfigured");
    accounts = { ...ACCOUNTS, INKIND_CLEARING: "35" };
    await expect(runInKindQbPosting(orgId)).resolves.toBe("unconfigured");
    expect(await inKindPostingOnAt(orgId)).toBeNull();
  });

  it("books a gift recorded after switch-on as one balanced journal entry, an asset line to fixed assets", async () => {
    await switchOn();
    const id = await acceptedGift();
    const [, lathe] = await lineIds(id);
    assets = [lathe];

    await expect(runInKindQbPosting(orgId)).resolves.toMatchObject({ posted: 1 });

    expect(qbo.posts).toHaveLength(1);
    const { body, key } = qbo.posts[0];
    expect(key).toBe(inKindKey(orgId, "receipt", id));
    expect(appKeyOf(body)).toBe(key);
    expect(body.TxnDate).toBe("2026-10-20");
    expect(body.Line.map((l) => [l.JournalEntryLineDetail.PostingType, l.JournalEntryLineDetail.AccountRef.value, l.Amount, l.JournalEntryLineDetail.ClassRef?.value])).toEqual([
      ["Credit", "400", 33, "77"],
      ["Debit", "600", 11, "77"],
      ["Debit", "150", 22, "77"],
    ]);
    expect(JSON.stringify(body)).not.toMatch(/Jane|Doe/);
    expect(await posting(id)).toMatchObject({ matchState: "CREATED", bookedTotalCents: 3300, bookedTxnDate: "2026-10-20", claimedAt: null });
    expect(await bookings(id)).toMatchObject([{ side: "journal", qbEntity: "JournalEntry", qbTxnId: "9000", matchState: "CREATED" }]);
    const [item] = await inKindAcceptService.listQueue(orgId, FINANCE);
    expect(item).toBeUndefined();

    await expect(runInKindQbPosting(orgId)).resolves.toMatchObject({ posted: 0 });
    expect(qbo.posts).toHaveLength(1);
  });

  it("never books a gift while a line waits on capital review", async () => {
    await switchOn();
    const id = await acceptedGift();
    awaiting = [{ giftSource: "receipt", giftId: id }];
    await expect(runInKindQbPosting(orgId)).resolves.toMatchObject({ posted: 0 });
    expect(qbo.posts).toHaveLength(0);
    expect(await db.inKindPosting.count()).toBe(0);
  });

  it("a gift without a receipt accepted with a $0 line goes to finance, never booked", async () => {
    await switchOn();
    const now = new Date();
    const { id } = await db.manualInKindDonation.create({
      data: {
        orgId,
        donorFirstName: "Sam",
        donorLastName: "Giver",
        donationDate: "2026-10-20",
        recordedByUserId: UPLOADER,
        decisionOutcome: "ACCEPTED",
        decidedByUserId: FINANCE,
        decidedAt: now,
        donorHouseholdAttestedAt: now,
        budgetOwnerId: 1,
        bucketAssignedByUserId: FINANCE,
        bucketAssignedAt: now,
        capitalSubmittedAt: now,
        lines: { create: [{ gtin13: "0011111111116", quantity: 1, valueCents: 3000 }, { gtin13: "0011111111116", quantity: 1, valueCents: 0 }] },
      },
    });
    await expect(runInKindQbPosting(orgId)).resolves.toMatchObject({ posted: 0, needs_finance: 1 });
    expect(qbo.posts).toHaveLength(0);
    const held = await db.inKindPosting.findUniqueOrThrow({ where: { orgId_source_giftId: { orgId, source: "manual", giftId: id } } });
    expect(held).toMatchObject({ matchState: "NEEDS_FINANCE", qbNote: expect.stringContaining("no value") });
  });

  it("before switch-on it only matches: a gift it cannot match waits for finance, unbooked", async () => {
    const id = await acceptedGift();
    await expect(runInKindQbPosting(orgId)).resolves.toMatchObject({ unbooked: 1 });
    expect(qbo.posts).toHaveLength(0);
    expect(await posting(id)).toMatchObject({ matchState: "UNBOOKED", qbCreateAttemptedAt: null });
  });

  it("matches finance's clearing-account pair and claims both entries", async () => {
    const id = await acceptedGift();
    qbo.deposits.push({ Id: "51", TxnDate: "2026-10-21", TotalAmt: 33, DepositToAccountRef: { value: "290" } });
    qbo.purchases.push({ Id: "52", TxnDate: "2026-10-21", TotalAmt: 33, AccountRef: { value: "290" } });
    qbo.deposits.push({ Id: "53", TxnDate: "2026-10-21", TotalAmt: 33, DepositToAccountRef: { value: "35" } });

    await expect(runInKindQbPosting(orgId)).resolves.toMatchObject({ matched: 1 });

    expect(qbo.posts).toHaveLength(0);
    expect(await bookings(id)).toMatchObject([
      { side: "expense", qbEntity: "Purchase", qbTxnId: "52", matchState: "MATCHED" },
      { side: "revenue", qbEntity: "Deposit", qbTxnId: "51", matchState: "MATCHED" },
    ]);
    expect(await posting(id)).toMatchObject({ matchState: "MATCHED", bookedTotalCents: 3300 });
  });

  it("two gifts of the same value and date are finance's to match, never first-come", async () => {
    const a = await acceptedGift();
    const b = await acceptedGift();
    qbo.deposits.push({ Id: "51", TxnDate: "2026-10-20", TotalAmt: 33, DepositToAccountRef: { value: "290" } });
    qbo.purchases.push({ Id: "52", TxnDate: "2026-10-20", TotalAmt: 33, AccountRef: { value: "290" } });

    await expect(runInKindQbPosting(orgId)).resolves.toMatchObject({ needs_finance: 2 });
    expect(await db.inKindBooking.count()).toBe(0);
    for (const id of [a, b]) expect((await posting(id)).qbNote).toMatch(/another of the same value/);
  });

  it("a half pair goes to finance and is never booked as a whole entry", async () => {
    await switchOn();
    const id = await acceptedGift();
    qbo.deposits.push({ Id: "51", TxnDate: "2026-10-20", TotalAmt: 33, DepositToAccountRef: { value: "290" } });
    await expect(runInKindQbPosting(orgId)).resolves.toMatchObject({ needs_finance: 1 });
    expect(qbo.posts).toHaveLength(0);
    expect((await posting(id)).qbNote).toMatch(/Deposit 51/);
  });

  it("nothing dated on or before the books closing date is booked", async () => {
    await switchOn();
    qbo.closeDate = "2026-10-31";
    const id = await acceptedGift();
    await expect(runInKindQbPosting(orgId)).resolves.toMatchObject({ unbooked: 1 });
    expect(qbo.posts).toHaveLength(0);
    expect((await posting(id)).qbNote).toMatch(/closed books/);
  });

  it("a create that landed but went unanswered is found by its key next run, never booked twice", async () => {
    await switchOn();
    const id = await acceptedGift();
    qbo.dropAfterCreate = true;
    await expect(runInKindQbPosting(orgId)).resolves.toMatchObject({ failed: 1 });
    expect(await posting(id)).toMatchObject({ matchState: "POST_FAILED" });
    expect((await posting(id)).qbCreateAttemptedAt).not.toBeNull();

    qbo.dropAfterCreate = false;
    await expect(runInKindQbPosting(orgId)).resolves.toMatchObject({ posted: 1 });
    expect(qbo.posts).toHaveLength(1);
    expect(await bookings(id)).toMatchObject([{ side: "journal", qbTxnId: "9000" }]);
  });

  it("the daily sweep notes an app entry its gift does not hold", async () => {
    await switchOn();
    const id = await acceptedGift();
    await runInKindQbPosting(orgId);
    const key = inKindKey(orgId, "receipt", id);
    qbo.journals.push({ Id: "9100", TxnDate: "2026-10-20", TotalAmt: 33, PrivateNote: `[checkin-test] [checkin:${key}]` });
    qbo.createTimes.set("9100", new Date());

    await expect(runInKindQbPosting(orgId)).resolves.toMatchObject({ sweep: { flagged: 1 } });
    expect((await posting(id)).qbNote).toMatch(/JournalEntry 9100 carries this gift's key but is not linked/);
  });
});
