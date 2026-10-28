/**
 * The in-kind drain: an accepted gift that waits on nothing but booking becomes one QuickBooks
 * JournalEntry, through the real QuickBooksClient over an in-memory company, unless finance's
 * clearing-account pair is found first. Nothing books on or before the books closing date.
 * Finance books, skips or matches by id what the drain hands over.
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
import { InKindQbResolveInputSchema, resolveInKindQb, type InKindQbResolveInput } from "../../lib/in-kind-resolve";
import type { InKindCapital, OwnerInfo } from "../../contract";
import { TEST_ORG_ID } from "../helpers/factories";

const orgId = TEST_ORG_ID;
const FINANCE = 10;
const UPLOADER = 7;
const ACCOUNTS: Partial<Record<BooksMapRole, string>> = { INKIND_INCOME: "400", INKIND_EXPENSE: "600", FIXED_ASSETS: "150", INKIND_CLEARING: "290", BENEVITY_BANK: "35" };
const BUCKETS: OwnerInfo[] = [
  { id: 1, name: "Robotics", archivedAt: null, quickBooksClassId: "C1" },
  { id: 2, name: "Shop", archivedAt: null, quickBooksClassId: "C2" },
];
const ACTOR = { actorUserId: FINANCE, actorUsername: "finance", correlationId: null };
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
  /** Runs inside a by-id read, standing in for a drain post that lands meanwhile. */
  duringByIdRead: (() => Promise<void>) | null = null;
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
      const byId = /FROM (JournalEntry|Deposit|Purchase) WHERE Id IN \('([^']+)'\)/.exec(query);
      if (byId) {
        await this.duringByIdRead?.();
        const all: { Id: string }[] = byId[1] === "JournalEntry" ? this.journals : byId[1] === "Deposit" ? this.deposits : this.purchases;
        const list = all.filter((e) => e.Id === byId[2]);
        return json({ QueryResponse: list.length ? { [byId[1]]: list } : {} });
      }
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
      booksMap: { accounts: async () => accounts, classes: async () => new Map([[1, "77"], [2, "78"]]) },
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

    await expect(inKindAcceptService.decide("receipt", id, { ...ACCEPT, bucketId: 2 }, { actorUserId: FINANCE, actorUsername: "finance" })).rejects.toMatchObject({ status: 409 });

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

const resolve = (id: number, input: InKindQbResolveInput) => resolveInKindQb(orgId, "receipt", id, input, ACTOR);
const events = (type: string) => db.workflowEvent.findMany({ where: { orgId, eventType: type }, orderBy: { id: "asc" } });
/** Gifts recorded before the lane switched on, which the drain handed to finance: nothing in QuickBooks matched them. */
async function unbookedGifts(n: number): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push(await acceptedGift());
  await runInKindQbPosting(orgId);
  for (const id of ids) expect((await posting(id)).matchState).toBe("UNBOOKED");
  return ids;
}
const unbookedGift = async () => (await unbookedGifts(1))[0];
const handJournal = (id: string, lines: [string, string, number][], total = 33): QboJournalEntry => ({
  Id: id,
  TxnDate: "2026-10-20",
  TotalAmt: total,
  Line: lines.map(([type, account, amount]) => ({ Amount: amount, JournalEntryLineDetail: { PostingType: type as "Debit" | "Credit", AccountRef: { value: account } } })),
});

describeDb("finance's QuickBooks actions on an in-kind gift", () => {
  it("takes book, skip with a reason, or match by journal entry id or by a deposit and a purchase", () => {
    const ok = (v: unknown) => InKindQbResolveInputSchema.safeParse(v).success;
    expect(ok({ action: "book" })).toBe(true);
    expect(ok({ action: "skip", reason: "Booked by hand" })).toBe(true);
    expect(ok({ action: "skip", reason: "  " })).toBe(false);
    expect(ok({ action: "skip" })).toBe(false);
    expect(ok({ action: "match", journalEntryId: "88" })).toBe(true);
    expect(ok({ action: "match", depositId: "51", purchaseId: "52" })).toBe(true);
    expect(ok({ action: "match", depositId: "51" })).toBe(false);
    expect(ok({ action: "match", journalEntryId: "88", depositId: "51", purchaseId: "52" })).toBe(false);
    expect(ok({ action: "clear", reason: "Voided it" })).toBe(true);
    expect(ok({ action: "clear" })).toBe(false);
  });

  it("skip settles the gift with the reason audited, and it leaves the queue and the drain for good", async () => {
    const id = await unbookedGift();
    const row = await resolve(id, { action: "skip", reason: "Booked by hand in 2025" });
    expect(row).toMatchObject({ id, qbState: "DISMISSED", waitingOn: [] });
    expect(JSON.stringify(row)).not.toMatch(/Jane|Doe/);
    const [event] = await events("IN_KIND_QB_SETTLED").then((e) => e.filter((x) => x.actorUserId === FINANCE));
    expect(JSON.parse(event.payload ?? "{}")).toMatchObject({ from: "UNBOOKED", to: "DISMISSED", manual: true, reason: "Booked by hand in 2025" });
    expect(await inKindAcceptService.listQueue(orgId, FINANCE)).toEqual([]);

    await switchOn();
    await runInKindQbPosting(orgId);
    expect(qbo.posts).toHaveLength(0);
    await expect(resolve(id, { action: "skip", reason: "again" })).rejects.toMatchObject({ status: 409 });
  });

  it("skip needs a reason and a gift the drain handed over", async () => {
    const id = await acceptedGift();
    await expect(resolve(id, { action: "skip", reason: " " })).rejects.toMatchObject({ status: 400 });
    await expect(resolve(id, { action: "skip", reason: "x" })).rejects.toMatchObject({ status: 409 });
    await expect(resolve(999_999, { action: "skip", reason: "x" })).rejects.toMatchObject({ status: 404 });
  });

  it("book creates the journal entry for a gift recorded before switch-on, audited as finance", async () => {
    const id = await unbookedGift();
    const row = await resolve(id, { action: "book" });
    expect(row).toMatchObject({ qbState: "CREATED", revenueBooking: "CREATED", expenseBooking: "CREATED" });
    expect(qbo.posts).toHaveLength(1);
    expect(await events("IN_KIND_QB_BOOK_REQUESTED")).toMatchObject([{ actorUserId: FINANCE }]);
    expect((await events("IN_KIND_QB_SETTLED")).at(-1)).toMatchObject({ actorUserId: FINANCE });
  });

  it("book is refused while a line waits on capital review", async () => {
    const id = await unbookedGift();
    awaiting = [{ giftSource: "receipt", giftId: id }];
    await expect(resolve(id, { action: "book" })).rejects.toMatchObject({ status: 409 });
    expect(qbo.posts).toHaveLength(0);
    expect((await posting(id)).matchState).toBe("UNBOOKED");
  });

  it("book is refused in closed books; the gift can only be skipped", async () => {
    qbo.closeDate = "2026-10-31";
    const id = await unbookedGift();
    await expect(resolve(id, { action: "book" })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/only be skipped/) });
    expect(qbo.posts).toHaveLength(0);
  });

  it("matches a hand-booked journal entry by id only when it is for the gift's value on in-kind accounts", async () => {
    const id = await unbookedGift();
    qbo.journals.push(handJournal("80", [["Credit", "400", 30], ["Debit", "600", 30]], 30));
    qbo.journals.push(handJournal("81", [["Credit", "400", 33], ["Debit", "35", 33]]));
    qbo.journals.push(handJournal("82", [["Credit", "400", 33], ["Debit", "600", 11], ["Debit", "150", 22]]));
    await expect(resolve(id, { action: "match", journalEntryId: "80" })).rejects.toMatchObject({ status: 422 });
    await expect(resolve(id, { action: "match", journalEntryId: "81" })).rejects.toMatchObject({ status: 422 });
    await expect(resolve(id, { action: "match", journalEntryId: "404" })).rejects.toMatchObject({ status: 422 });

    expect(await resolve(id, { action: "match", journalEntryId: "82" })).toMatchObject({ qbState: "MATCHED" });
    expect(await bookings(id)).toMatchObject([{ side: "journal", qbEntity: "JournalEntry", qbTxnId: "82", matchState: "MATCHED" }]);
    expect(JSON.parse((await events("IN_KIND_QB_SETTLED")).at(-1)?.payload ?? "{}")).toMatchObject({ manual: true, to: "MATCHED" });
  });

  it("a match claims the entries once: a second gift is refused by the unique index", async () => {
    const [a, b] = await unbookedGifts(2);
    qbo.deposits.push({ Id: "51", TxnDate: "2026-10-20", TotalAmt: 33, DepositToAccountRef: { value: "290" } });
    qbo.purchases.push({ Id: "52", TxnDate: "2026-10-20", TotalAmt: 33, AccountRef: { value: "290" } });

    expect(await resolve(a, { action: "match", depositId: "51", purchaseId: "52" })).toMatchObject({ qbState: "MATCHED" });
    await expect(resolve(b, { action: "match", depositId: "51", purchaseId: "52" })).rejects.toMatchObject({ status: 409 });
    expect(await bookings(b)).toEqual([]);
    expect((await posting(b)).matchState).toBe("UNBOOKED");
  });

  it("a pair match is refused off the clearing account", async () => {
    const id = await unbookedGift();
    qbo.deposits.push({ Id: "51", TxnDate: "2026-10-20", TotalAmt: 33, DepositToAccountRef: { value: "35" } });
    qbo.purchases.push({ Id: "52", TxnDate: "2026-10-20", TotalAmt: 33, AccountRef: { value: "290" } });
    await expect(resolve(id, { action: "match", depositId: "51", purchaseId: "52" })).rejects.toMatchObject({ status: 422 });
    expect(await bookings(id)).toEqual([]);
  });

  it("a match is refused when the drain attempts a create between the read and the write", async () => {
    const id = await unbookedGift();
    qbo.journals.push(handJournal("82", [["Credit", "400", 33], ["Debit", "600", 33]]));
    qbo.duringByIdRead = async () => {
      await db.inKindPosting.update({ where: { orgId_source_giftId: { orgId, source: "receipt", giftId: id } }, data: { qbCreateAttemptedAt: new Date() } });
    };
    await expect(resolve(id, { action: "match", journalEntryId: "82" })).rejects.toMatchObject({ status: 409 });
    expect(await bookings(id)).toEqual([]);
    expect((await posting(id)).matchState).toBe("UNBOOKED");
  });

  it("a skipped gift stays in the queue while it carries a note, such as the sweep's stray entry", async () => {
    const id = await unbookedGift();
    await resolve(id, { action: "skip", reason: "Booked by hand" });
    expect(await inKindAcceptService.listQueue(orgId, FINANCE)).toEqual([]);
    const qbNote = "QuickBooks JournalEntry 9100 carries this gift's key but is not linked to it; void it or link it";
    await db.inKindPosting.update({ where: { orgId_source_giftId: { orgId, source: "receipt", giftId: id } }, data: { qbNote } });
    expect(await inKindAcceptService.listQueue(orgId, FINANCE)).toMatchObject([{ id, state: null, waitingOn: [], qbState: "DISMISSED", qbNote }]);
  });

  it("clear answers a note, audited with the stray entry it names, and the sweep never notes that entry again", async () => {
    await switchOn();
    const id = await acceptedGift();
    await runInKindQbPosting(orgId);
    const key = inKindKey(orgId, "receipt", id);
    qbo.journals.push({ Id: "9100", TxnDate: "2026-10-20", TotalAmt: 33, PrivateNote: `[checkin-test] [checkin:${key}]` });
    qbo.createTimes.set("9100", new Date());
    await expect(runInKindQbPosting(orgId)).resolves.toMatchObject({ sweep: { flagged: 1 } });
    expect(await inKindAcceptService.listQueue(orgId, FINANCE)).toMatchObject([{ id, qbState: "CREATED", qbNote: expect.stringMatching(/JournalEntry 9100/) }]);

    await expect(resolve(id, { action: "clear", reason: " " })).rejects.toMatchObject({ status: 400 });
    expect(await resolve(id, { action: "clear", reason: "Voided 9100 in QuickBooks" })).toMatchObject({ qbState: "CREATED", qbNote: null });
    const [cleared] = await events("IN_KIND_QB_NOTE_CLEARED");
    expect(cleared).toMatchObject({ actorUserId: FINANCE });
    expect(JSON.parse(cleared.payload ?? "{}")).toMatchObject({ reason: "Voided 9100 in QuickBooks", answeredEntries: ["JournalEntry:9100"] });
    expect(await inKindAcceptService.listQueue(orgId, FINANCE)).toEqual([]);

    await expect(runInKindQbPosting(orgId)).resolves.toMatchObject({ sweep: { flagged: 0 } });
    expect((await posting(id)).qbNote).toBeNull();
    await expect(resolve(id, { action: "clear", reason: "again" })).rejects.toMatchObject({ status: 409 });
  });

  it("skip and match look first for the app's own entry and link it instead", async () => {
    await switchOn();
    const id = await acceptedGift();
    qbo.dropAfterCreate = true;
    await expect(runInKindQbPosting(orgId)).resolves.toMatchObject({ failed: 1 });
    qbo.dropAfterCreate = false;

    expect(await resolve(id, { action: "skip", reason: "looks unbooked" })).toMatchObject({ qbState: "CREATED" });
    expect(await bookings(id)).toMatchObject([{ side: "journal", qbTxnId: "9000", matchState: "CREATED" }]);
    expect(qbo.posts).toHaveLength(1);
  });
});
