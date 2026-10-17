/**
 * QB-2 write path: the outbox drains into QuickBooks through the real QuickBooksClient over an
 * in-memory QBO company. One entry per expense; match before create; the key makes a retry safe.
 */
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { QuickBooksClient, qbKey, type QboBill, type QboPurchase } from "@inventory/quickbooks";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { TEST_BUCKETS, bindPorts, catalogResolving, principal, seedApproval, seedExpense, seedLineItem, signAllLines, ORG } from "../helpers/seed";
import { checkAndProcessExpense, retryQbPost } from "../../lib/expense-qb-processor";
import {
  MAX_CONSECUTIVE_FAILURES, MAX_CREATE_CENTS_PER_RUN, MAX_CREATES_PER_DAY, MAX_POST_ATTEMPTS, STALE_CLAIM_MS, drainExpenseOutbox, postExpenseToQb,
} from "../../lib/expense-qb-poster";
import { resubmitHeldExpense, setHeldLineAccount } from "../../services/holdService";
import { runExpenseQbPosting } from "../../services/sweeps";

const PAYMENT_ACCOUNT = "41";
const VENDOR = "77";

interface PostedLine {
  Amount: number;
  AccountBasedExpenseLineDetail: { AccountRef: { value: string }; ClassRef?: { value: string } };
}
interface PostedTxn {
  TxnDate: string;
  AccountRef?: { value: string };
  VendorRef?: { value: string };
  Line: PostedLine[];
  PrivateNote: string;
}

/** Windowed Purchase/Bill reads and Purchase/Bill creates. */
class FakeQbo {
  purchases: QboPurchase[] = [];
  bills: QboBill[] = [];
  posts: { entity: string; key: string; body: PostedTxn }[] = [];
  mode: "ok" | "down" | "accept-then-drop" = "ok";
  /** While set, every request waits on it: a QuickBooks call still in flight. */
  gate: Promise<void> | null = null;
  private nextId = 5000;

  handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (this.gate) await this.gate;
    const url = new URL(String(input));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { intuit_tid: "tid" } });
    if (this.mode === "down") return json({ Fault: { Error: [{ code: "3100" }] } }, 503);
    if ((init?.method ?? "GET") === "GET") {
      const m = /FROM (Purchase|Bill) WHERE TxnDate >= '([\d-]+)' AND TxnDate <= '([\d-]+)'/.exec(url.searchParams.get("query") ?? "");
      if (!m) throw new Error(`unexpected query ${url.search}`);
      const list = (m[1] === "Purchase" ? this.purchases : this.bills).filter((t) => t.TxnDate >= m[2] && t.TxnDate <= m[3]);
      return json({ QueryResponse: list.length ? { [m[1]]: list } : {} });
    }
    const entity = url.pathname.endsWith("/bill") ? "Bill" : "Purchase";
    const body = JSON.parse(String(init?.body)) as PostedTxn;
    this.posts.push({ entity, key: url.searchParams.get("requestid") ?? "", body });
    const Id = String(this.nextId++);
    const TotalAmt = body.Line.reduce((s, l) => s + Math.round(l.Amount * 100), 0) / 100;
    const row = { Id, TxnDate: body.TxnDate, TotalAmt, AccountRef: body.AccountRef, VendorRef: body.VendorRef, PrivateNote: body.PrivateNote };
    (entity === "Bill" ? this.bills : this.purchases).push(row);
    if (this.mode === "accept-then-drop") throw new Error("socket hang up");
    return json({ [entity]: { Id } });
  };
}

let qbo: FakeQbo;

const posting = (takeoverDate: string | null = "2026-01-01", prod = false) => ({
  client: new QuickBooksClient({ current: async () => "tok" }, { env: "sandbox", realmId: "123" }),
  paymentAccountId: PAYMENT_ACCOUNT,
  paymentType: "CreditCard" as const,
  takeoverDate,
  prod,
});

function bindQbo(takeoverDate?: string | null, prod?: boolean) {
  bindPorts({ quickbooks: { posting: posting(takeoverDate, prod) } });
}

/** A hand-booked match dated `day`: sets the takeover line there. */
async function handMatched(day: string) {
  const id = await seedExpense({ state: "qb_complete" });
  await db.expense.update({ where: { id }, data: { receiptDate: day, qbMatchState: "MATCHED", qbTxnId: `hand-${day}`, qbTxnEntity: "Purchase" } });
}

/**
 * An expense already in the outbox, every line signed: lines on accounts 60 and 61 in buckets 7 and 100,
 * receipt dated `day`; test data from a TEST- vendor unless told otherwise. A null bucket leaves bucketId
 * off the event.
 */
async function outboxed(
  day: string,
  opts: {
    reimburseePersonId?: number;
    amounts?: [number, number];
    isTestData?: boolean;
    vendorName?: string;
    buckets?: [number | null, number | null];
  } = {},
) {
  const vendorName = opts.vendorName ?? "TEST-Acme";
  const [a, b] = opts.amounts ?? [700, 300];
  const id = await seedExpense({
    state: "qb_complete",
    receiptTotalCents: a + b,
    needsReimbursement: opts.reimburseePersonId !== undefined,
    reimburseePersonId: opts.reimburseePersonId,
  });
  await db.expense.update({ where: { id }, data: { receiptDate: day, isTestData: opts.isTestData ?? true, vendorName } });
  const l1 = await seedLineItem(id, { totalPriceCents: a });
  const l2 = await seedLineItem(id, { totalPriceCents: b });
  const [b1, b2] = opts.buckets ?? [7, 100];
  const item = (lineItemId: number, cents: number, account: string, bucketId: number | null) => ({
    lineItemId, description: "Widget", quantity: 1, unitPriceCents: cents, totalPriceCents: cents,
    allocatedTaxCents: 0, allocatedShippingCents: 0, allocatedDiscountCents: 0,
    isDelayed: false, isCapital: false, capitalOwnerId: null, depreciationYears: null, account,
    ...(bucketId !== null && { bucketId }),
  });
  const payload = {
    schemaVersion: 1, id, vendorName, receiptDate: day, receiptTotalCents: a + b, orgId: ORG,
    needsReimbursement: opts.reimburseePersonId !== undefined, reimbursementFor: null,
    reimburseePersonId: opts.reimburseePersonId ?? null,
    items: [item(l1, a, "60", b1), item(l2, b, "61", b2)],
  };
  await db.expenseEvent.create({ data: { orgId: ORG, expenseId: id, payload: JSON.stringify(payload) } });
  await signAllLines(id);
  return { id, lines: [l1, l2] };
}

const expenseRow = (id: string) => db.expense.findUniqueOrThrow({ where: { id } });

beforeEach(() => {
  qbo = new FakeQbo();
  vi.stubGlobal("fetch", vi.fn(qbo.handle));
  bindQbo();
});
afterEach(() => vi.unstubAllGlobals());

describeDb("QB-2 posting — create", () => {
  it("posts one Purchase per expense with a line per item, CREATED with the ids stored", async () => {
    await handMatched("2026-08-01");
    const { id, lines } = await outboxed("2026-09-10");

    expect(await postExpenseToQb(ORG, id)).toBe("posted");

    expect(qbo.posts).toHaveLength(1);
    const { entity, key, body } = qbo.posts[0];
    expect(entity).toBe("Purchase");
    expect(key).toBe(qbKey("expense", id));
    expect(body.PrivateNote).toContain(`[checkin:${key}]`);
    expect(body.AccountRef).toEqual({ value: PAYMENT_ACCOUNT });
    expect(body.Line.map((l) => [l.Amount, l.AccountBasedExpenseLineDetail.AccountRef.value])).toEqual([[7, "60"], [3, "61"]]);

    const row = await expenseRow(id);
    expect(row).toMatchObject({ qbMatchState: "CREATED", qbTxnId: qbo.purchases[0].Id, qbTxnEntity: "Purchase", qbVendorId: null });
    const posted = await db.expenseLineItem.findMany({ where: { id: { in: lines } }, orderBy: { id: "asc" } });
    expect(posted.map((l) => l.qbAccountId)).toEqual(["60", "61"]);
  });

  it("posts a reimbursement as a Bill to the reimbursee's Vendor and stores the vendor id", async () => {
    await handMatched("2026-08-01");
    await db.expenseReimburseeVendor.create({ data: { orgId: ORG, reimburseePersonId: 42, qbVendorId: VENDOR } });
    const { id } = await outboxed("2026-09-10", { reimburseePersonId: 42 });

    expect(await postExpenseToQb(ORG, id)).toBe("posted");
    expect(qbo.posts[0].entity).toBe("Bill");
    expect(qbo.posts[0].body.VendorRef).toEqual({ value: VENDOR });
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "CREATED", qbTxnEntity: "Bill", qbVendorId: VENDOR });
  });

  it("queues a reimbursee with no Vendor as AMBIGUOUS and posts nothing", async () => {
    await handMatched("2026-08-01");
    const { id } = await outboxed("2026-09-10", { reimburseePersonId: 43 });

    expect(await postExpenseToQb(ORG, id)).toBe("queued");
    expect(qbo.posts).toHaveLength(0);
    expect((await expenseRow(id)).qbMatchState).toBe("AMBIGUOUS");
  });

  it("posts right after the outbox commit on the request path", async () => {
    await handMatched("2026-08-01");
    bindPorts({
      catalog: catalogResolving({}),
      quickbooks: { posting: posting() },
    });
    const id = await seedExpense({ state: "qb_pending", receiptTotalCents: 500 });
    await db.expense.update({ where: { id }, data: { receiptDate: "2026-09-10", isTestData: true, vendorName: "TEST-Acme" } });
    const line = await seedLineItem(id, { manualQbAccount: "60", totalPriceCents: 500 });
    await seedApproval(id, line, { ownerId: 7, status: "approved" });
    await signAllLines(id);

    await checkAndProcessExpense(ORG, id);

    expect((await expenseRow(id)).state).toBe("qb_complete");
    expect(qbo.posts).toHaveLength(1);
    expect((await expenseRow(id)).qbMatchState).toBe("CREATED");
  });
});

describeDb("QB-2 posting — match before create", () => {
  it("links a hand-booked Purchase two days off and creates nothing", async () => {
    await handMatched("2026-08-01");
    const { id } = await outboxed("2026-09-10");
    qbo.purchases.push({ Id: "900", TxnDate: "2026-09-12", TotalAmt: 10, AccountRef: { value: PAYMENT_ACCOUNT } });

    expect(await postExpenseToQb(ORG, id)).toBe("matched");
    expect(qbo.posts).toHaveLength(0);
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "MATCHED", qbTxnId: "900" });
    expect(JSON.parse((await expenseRow(id)).qbMatchBaseline ?? "null")).toEqual({ amountCents: 1000, accounts: [], vendorId: null });
  });

  it("posts nothing at all without a configured takeover date, even past a hand match", async () => {
    bindQbo(null);
    await handMatched("2026-08-01");
    const { id } = await outboxed("2026-09-10");

    expect(await postExpenseToQb(ORG, id)).toBe("no_takeover_date");
    expect(await drainExpenseOutbox()).toBe("no_takeover_date");
    expect(qbo.posts).toHaveLength(0);
    expect((await expenseRow(id)).qbMatchState).toBe("UNMATCHED");
  });

  it("the configured takeover date alone lets a later expense be created", async () => {
    const { id } = await outboxed("2026-09-10");
    expect(await postExpenseToQb(ORG, id)).toBe("posted");
  });

  it("an older hand match never moves the line before the configured date", async () => {
    bindQbo("2026-09-15");
    await handMatched("2026-08-01");
    const { id } = await outboxed("2026-09-10");

    expect(await postExpenseToQb(ORG, id)).toBe("queued");
    expect(qbo.posts).toHaveLength(0);
    expect((await expenseRow(id)).qbMatchState).toBe("BEFORE_LINE");
  });

  it("sends an expense on or before the takeover line to finance as BEFORE_LINE", async () => {
    await handMatched("2026-09-20");
    const { id } = await outboxed("2026-09-10");

    expect(await postExpenseToQb(ORG, id)).toBe("queued");
    expect(qbo.posts).toHaveLength(0);
    expect((await expenseRow(id)).qbMatchState).toBe("BEFORE_LINE");
  });
});

describeDb("QB-2 posting — retries and recovery", () => {
  it("a retry after QBO accepted but the response was lost finds the entry by key, never a second booking", async () => {
    await handMatched("2026-08-01");
    const { id } = await outboxed("2026-09-10");

    qbo.mode = "accept-then-drop";
    expect(await postExpenseToQb(ORG, id)).toBe("failed");
    expect((await expenseRow(id)).qbMatchState).toBe("POST_FAILED");

    qbo.mode = "ok";
    const counts = await drainExpenseOutbox();
    expect(counts).toMatchObject({ posted: 1, failed: 0 });
    expect(qbo.posts).toHaveLength(1);
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "CREATED", qbTxnId: qbo.purchases[0].Id });
  });

  it("QuickBooks down leaves the expense postable, and the catch-up sweep posts it", async () => {
    await handMatched("2026-08-01");
    const { id } = await outboxed("2026-09-10");

    qbo.mode = "down";
    expect(await postExpenseToQb(ORG, id)).toBe("failed");
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "POST_FAILED", qbTxnId: null });

    qbo.mode = "ok";
    const result = await runExpenseQbPosting();
    expect(result.qbPost).toMatchObject({ posted: 1 });
    expect((await expenseRow(id)).qbMatchState).toBe("CREATED");
  });

  it("a second drain posts nothing more", async () => {
    await handMatched("2026-08-01");
    await outboxed("2026-09-10");
    await drainExpenseOutbox();
    expect(await drainExpenseOutbox()).toMatchObject({ posted: 0 });
    expect(qbo.posts).toHaveLength(1);
  });

  it("does nothing while QuickBooks is unbound", async () => {
    bindPorts({});
    await handMatched("2026-08-01");
    const { id } = await outboxed("2026-09-10");
    expect(await postExpenseToQb(ORG, id)).toBe("unbound");
    expect(await drainExpenseOutbox()).toBe("unbound");
    expect((await expenseRow(id)).qbMatchState).toBe("UNMATCHED");
  });
});

describeDb("QB-2 posting — test-data gate", () => {
  it("outside prod, an expense not flagged as test data is not sent, with a visible reason", async () => {
    const { id } = await outboxed("2026-09-10", { isTestData: false });

    expect(await postExpenseToQb(ORG, id)).toBe("not_sent");
    expect(await drainExpenseOutbox()).toMatchObject({ posted: 0, not_sent: 1 });
    expect(qbo.posts).toHaveLength(0);
    expect((await expenseRow(id)).qbMatchState).toBe("NOT_TEST_DATA");
    const audit = await db.expenseAuditLog.findMany({ where: { expenseId: id } });
    expect(audit.map((a) => a.notes)).toEqual(["not sent to QuickBooks: not test data"]);
  });

  it("outside prod, flagged test data with a real-looking vendor name is not sent", async () => {
    const { id } = await outboxed("2026-09-10", { vendorName: "Home Depot" });

    expect(await postExpenseToQb(ORG, id)).toBe("not_sent");
    expect(qbo.posts).toHaveLength(0);
    expect((await expenseRow(id)).qbMatchState).toBe("NOT_TEST_DATA");
  });

  it("the gate is re-checked each run: flagging the expense later lets the drain post it", async () => {
    const { id } = await outboxed("2026-09-10", { isTestData: false });
    await postExpenseToQb(ORG, id);
    await db.expense.update({ where: { id }, data: { isTestData: true } });

    expect(await drainExpenseOutbox()).toMatchObject({ posted: 1 });
    expect((await expenseRow(id)).qbMatchState).toBe("CREATED");
  });

  it("in prod, test data is refused and never posted", async () => {
    bindQbo("2026-01-01", true);
    const { id } = await outboxed("2026-09-10");

    expect(await postExpenseToQb(ORG, id)).toBe("not_sent");
    expect(await drainExpenseOutbox()).toMatchObject({ posted: 0, not_sent: 1 });
    expect(qbo.posts).toHaveLength(0);
    expect((await expenseRow(id)).qbMatchState).toBe("TEST_DATA_REFUSED");
  });

  it("in prod, a real expense posts", async () => {
    bindQbo("2026-01-01", true);
    const { id } = await outboxed("2026-09-10", { isTestData: false, vendorName: "Home Depot" });

    expect(await postExpenseToQb(ORG, id)).toBe("posted");
  });
});

describeDb("QB-2 posting — ids are unique per entity type", () => {
  it("a Bill and a Purchase with the same QuickBooks id are both recorded", async () => {
    const purchase = await outboxed("2026-09-10");
    await db.expense.update({ where: { id: purchase.id }, data: { qbMatchState: "CREATED", qbTxnId: "5000", qbTxnEntity: "Purchase" } });
    await db.expenseReimburseeVendor.create({ data: { orgId: ORG, reimburseePersonId: 42, qbVendorId: VENDOR } });
    const { id } = await outboxed("2026-09-11", { reimburseePersonId: 42 });

    expect(await postExpenseToQb(ORG, id)).toBe("posted");
    expect(await expenseRow(id)).toMatchObject({ qbTxnId: "5000", qbTxnEntity: "Bill" });
  });
});

describeDb("QB-2 posting — one claim per QuickBooks entry", () => {
  it("never matches an entry a line already holds, and records its own claim", async () => {
    await handMatched("2026-08-01");
    const { id } = await outboxed("2026-09-10");
    qbo.purchases.push({ Id: "900", TxnDate: "2026-09-12", TotalAmt: 10, AccountRef: { value: PAYMENT_ACCOUNT } });
    await db.expenseQbClaim.create({ data: { orgId: ORG, qbTxnEntity: "Purchase", qbTxnId: "900" } });

    expect(await postExpenseToQb(ORG, id)).toBe("posted");
    const row = await expenseRow(id);
    expect(row.qbTxnId).not.toBe("900");
    expect(await db.expenseQbClaim.count({ where: { orgId: ORG, qbTxnEntity: "Purchase", qbTxnId: row.qbTxnId! } })).toBe(1);
  });

  it("an entry it created that is already claimed goes to finance as AMBIGUOUS with a flag", async () => {
    await handMatched("2026-08-01");
    const { id } = await outboxed("2026-09-10");
    // The fake company hands out 5000 next; a claim on it stands in for one written mid-post.
    await db.expenseQbClaim.create({ data: { orgId: ORG, qbTxnEntity: "Purchase", qbTxnId: "5000" } });

    expect(await postExpenseToQb(ORG, id)).toBe("queued");
    expect(qbo.posts).toHaveLength(1);
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "AMBIGUOUS", qbTxnId: null });
    expect(await db.expenseFlag.count({ where: { expenseId: id, kind: "QB_POST_FAILED", checkedOffAt: null } })).toBe(1);
  });
});

describeDb("QB-2 posting — bounded retry", () => {
  /** Outboxed through the real processor on one manual line, so a finance retry can rebuild it. */
  async function outboxedManual(account: string) {
    bindPorts({ catalog: catalogResolving({}), quickbooks: { posting: posting() } });
    const id = await seedExpense({ state: "qb_pending", receiptTotalCents: 500 });
    await db.expense.update({ where: { id }, data: { receiptDate: "2026-09-10", isTestData: true, vendorName: "TEST-Acme" } });
    const line = await seedLineItem(id, { manualQbAccount: account, totalPriceCents: 500 });
    await seedApproval(id, line, { ownerId: 7, status: "approved" });
    await signAllLines(id);
    await checkAndProcessExpense(ORG, id);
    return { id, line };
  }

  it("a permanent rejection stops at NEEDS_FINANCE with a flag after the attempt limit, and the drain stops calling QuickBooks", async () => {
    const { id } = await outboxedManual("not-an-account");
    expect((await expenseRow(id)).qbMatchState).toBe("POST_FAILED");

    for (let i = 1; i < MAX_POST_ATTEMPTS; i++) await drainExpenseOutbox();
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "NEEDS_FINANCE", qbPostAttempts: MAX_POST_ATTEMPTS });
    const flags = await db.expenseFlag.findMany({ where: { expenseId: id } });
    expect(flags.map((f) => [f.kind, f.audience])).toEqual([["QB_POST_FAILED", "FINANCE"]]);
    const notes = (await db.expenseAuditLog.findMany({ where: { expenseId: id, fieldChanged: "qbMatchState" }, orderBy: { id: "asc" } })).map((a) => a.notes);
    expect(notes).toHaveLength(MAX_POST_ATTEMPTS);
    expect(notes.at(-1)).toMatch(new RegExp(`^attempt ${MAX_POST_ATTEMPTS} of ${MAX_POST_ATTEMPTS}: `));

    const fetches = vi.mocked(fetch).mock.calls.length;
    expect(await drainExpenseOutbox()).toMatchObject({ posted: 0, failed: 0 });
    expect(vi.mocked(fetch).mock.calls.length).toBe(fetches);
  });

  it("finance fixes the account and retries: the payload is rebuilt and the expense posts", async () => {
    const { id, line } = await outboxedManual("not-an-account");
    for (let i = 1; i < MAX_POST_ATTEMPTS; i++) await drainExpenseOutbox();
    expect((await expenseRow(id)).qbMatchState).toBe("NEEDS_FINANCE");

    const finance = principal(500, { isFinance: true });
    await setHeldLineAccount(finance, id, line, "60");
    await resubmitHeldExpense(finance, id);

    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "CREATED", qbPostAttempts: 0 });
    expect(qbo.posts).toHaveLength(1);
    expect(qbo.posts[0].body.Line[0].AccountBasedExpenseLineDetail.AccountRef).toEqual({ value: "60" });
  });

  it("an error thrown inside the post counts as an attempt, so it too stops at NEEDS_FINANCE with a flag", async () => {
    await handMatched("2026-08-01");
    const { id } = await outboxed("2026-09-10");
    // A payload line that no longer exists makes the line update throw after QuickBooks answers.
    const event = await db.expenseEvent.findFirstOrThrow({ where: { expenseId: id } });
    const payload = JSON.parse(event.payload);
    payload.items[0].lineItemId = 2_000_000_000;
    await db.expenseEvent.update({ where: { id: event.id }, data: { payload: JSON.stringify(payload) } });

    expect(await postExpenseToQb(ORG, id)).toBe("failed");
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "POST_FAILED", qbPostAttempts: 1, qbTxnId: null });

    for (let i = 1; i < MAX_POST_ATTEMPTS; i++) await drainExpenseOutbox();
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "NEEDS_FINANCE", qbPostAttempts: MAX_POST_ATTEMPTS });
    const flags = await db.expenseFlag.findMany({ where: { expenseId: id } });
    expect(flags.map((f) => f.kind)).toEqual(["QB_POST_FAILED"]);
    expect(qbo.posts).toHaveLength(1);
  });

  it("a refused retry answers 409 and records no retry", async () => {
    const { id, line } = await outboxedManual("not-an-account");
    for (let i = 1; i < MAX_POST_ATTEMPTS; i++) await drainExpenseOutbox();
    await db.expenseLineItem.update({ where: { id: line }, data: { manualQbAccount: null } });

    await expect(resubmitHeldExpense(principal(500, { isFinance: true }), id)).rejects.toMatchObject({ statusCode: 409 });

    expect(await db.expenseAuditLog.count({ where: { expenseId: id, action: "qb_post_retried" } })).toBe(0);
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "NEEDS_FINANCE", qbPostAttempts: MAX_POST_ATTEMPTS });
  });

  it("an accepted retry records who asked", async () => {
    const { id, line } = await outboxedManual("not-an-account");
    for (let i = 1; i < MAX_POST_ATTEMPTS; i++) await drainExpenseOutbox();
    const finance = principal(500, { isFinance: true });
    await setHeldLineAccount(finance, id, line, "60");
    await resubmitHeldExpense(finance, id);

    const retried = await db.expenseAuditLog.findMany({ where: { expenseId: id, action: "qb_post_retried" } });
    expect(retried.map((a) => a.userId)).toEqual([500]);
  });

  it("exhausting again after a retry reopens the checked-off QB_POST_FAILED flag", async () => {
    const { id } = await outboxedManual("not-an-account");
    for (let i = 1; i < MAX_POST_ATTEMPTS; i++) await drainExpenseOutbox();
    await db.expenseFlag.updateMany({ where: { expenseId: id }, data: { checkedOffAt: new Date(), checkedOffByUserId: 500 } });

    await resubmitHeldExpense(principal(500, { isFinance: true }), id);
    for (let i = 1; i < MAX_POST_ATTEMPTS; i++) await drainExpenseOutbox();

    expect((await expenseRow(id)).qbMatchState).toBe("NEEDS_FINANCE");
    const [flag] = await db.expenseFlag.findMany({ where: { expenseId: id } });
    expect(flag).toMatchObject({ kind: "QB_POST_FAILED", checkedOffAt: null });
  });
});

describeDb("QB-2 posting — per-run cents cap", () => {
  const big = MAX_CREATE_CENTS_PER_RUN + 100;

  it("an expense over the cap waits for a run of its own, posts alone, and is flagged", async () => {
    const small = await outboxed("2026-09-01");
    const large = await outboxed("2026-09-10", { amounts: [big - 300, 300] });

    expect(await drainExpenseOutbox()).toMatchObject({ posted: 1, capped: "cents" });
    expect((await expenseRow(small.id)).qbMatchState).toBe("CREATED");
    expect((await expenseRow(large.id)).qbMatchState).toBe("UNMATCHED");

    expect(await drainExpenseOutbox()).toMatchObject({ posted: 1, overCap: 1, capped: "cents" });
    expect((await expenseRow(large.id)).qbMatchState).toBe("CREATED");
    const flags = await db.expenseFlag.findMany({ where: { expenseId: large.id } });
    expect(flags.map((f) => f.kind)).toEqual(["QB_OVER_CAP"]);
  });

  it("an over-cap expense ends its run, so nothing else posts in it", async () => {
    const large = await outboxed("2026-09-01", { amounts: [big - 300, 300] });
    const after = await outboxed("2026-09-10");

    expect(await drainExpenseOutbox()).toMatchObject({ posted: 1, overCap: 1 });
    expect((await expenseRow(large.id)).qbMatchState).toBe("CREATED");
    expect((await expenseRow(after.id)).qbMatchState).toBe("UNMATCHED");
  });
});

describeDb("QB-2 posting — daily ceiling", () => {
  /** Audit rows for `n` QuickBooks creates at `changedAt`, as settle() writes them. */
  async function createdAt(n: number, changedAt: Date) {
    const id = await seedExpense({ state: "qb_complete" });
    await db.expenseAuditLog.createMany({
      data: Array.from({ length: n }, () => ({ expenseId: id, userId: 0, action: "qb_created", fieldChanged: "qbMatchState", changedAt })),
    });
  }

  it("at the ceiling nothing is sent: the expense waits, no attempt counted, and the drain logs the cap once", async () => {
    await createdAt(MAX_CREATES_PER_DAY, new Date());
    const a = await outboxed("2026-09-10");
    await outboxed("2026-09-11");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await postExpenseToQb(ORG, a.id)).toBe("waiting");
    expect(await drainExpenseOutbox()).toMatchObject({ posted: 0, failed: 0, capped: "day" });

    expect(qbo.posts).toHaveLength(0);
    expect(await expenseRow(a.id)).toMatchObject({ qbMatchState: "UNMATCHED", qbPostAttempts: 0 });
    expect(warn.mock.calls.filter(([m]) => String(m).includes('"qb_daily_cap"'))).toHaveLength(1);
    warn.mockRestore();
  });

  it("the drain stops at the ceiling partway through a run", async () => {
    await createdAt(MAX_CREATES_PER_DAY - 1, new Date());
    const first = await outboxed("2026-09-10");
    const second = await outboxed("2026-09-11");

    expect(await drainExpenseOutbox()).toMatchObject({ posted: 1, capped: "day" });
    expect((await expenseRow(first.id)).qbMatchState).toBe("CREATED");
    expect((await expenseRow(second.id)).qbMatchState).toBe("UNMATCHED");
  });

  it("creates from before UTC midnight do not count", async () => {
    const yesterday = new Date();
    yesterday.setUTCHours(0, 0, 0, 0);
    yesterday.setUTCMilliseconds(-1);
    await createdAt(MAX_CREATES_PER_DAY, yesterday);
    const { id } = await outboxed("2026-09-10");

    expect(await postExpenseToQb(ORG, id)).toBe("posted");
  });

  it("the post right after sign-off respects the ceiling and leaves the expense for a later run", async () => {
    await createdAt(MAX_CREATES_PER_DAY, new Date());
    bindPorts({ catalog: catalogResolving({}), quickbooks: { posting: posting() } });
    const id = await seedExpense({ state: "qb_pending", receiptTotalCents: 500 });
    await db.expense.update({ where: { id }, data: { receiptDate: "2026-09-10", isTestData: true, vendorName: "TEST-Acme" } });
    await seedLineItem(id, { manualQbAccount: "60", totalPriceCents: 500 });
    await signAllLines(id);

    await checkAndProcessExpense(ORG, id);

    expect(qbo.posts).toHaveLength(0);
    expect(await expenseRow(id)).toMatchObject({ state: "qb_complete", qbMatchState: "UNMATCHED", qbPostAttempts: 0 });
  });
});

describeDb("QB-2 posting — per-expense cap on the request path", () => {
  const big = MAX_CREATE_CENTS_PER_RUN + 100;

  it("a request-path post over the cap posts nothing, stays drain-postable and is flagged; the drain then posts it alone", async () => {
    const { id } = await outboxed("2026-09-10", { amounts: [big - 300, 300] });

    expect(await postExpenseToQb(ORG, id)).toBe("queued");
    expect(qbo.posts).toHaveLength(0);
    expect((await expenseRow(id)).qbMatchState).toBe("UNMATCHED");
    expect((await db.expenseFlag.findMany({ where: { expenseId: id } })).map((f) => f.kind)).toEqual(["QB_OVER_CAP"]);

    expect(await drainExpenseOutbox()).toMatchObject({ posted: 1, overCap: 1 });
    expect((await expenseRow(id)).qbMatchState).toBe("CREATED");
  });

  it("a finance retry of an over-cap expense leaves it for the drain", async () => {
    bindPorts({ catalog: catalogResolving({}), quickbooks: { posting: posting() } });
    const id = await seedExpense({ state: "qb_pending", receiptTotalCents: big });
    await db.expense.update({ where: { id }, data: { receiptDate: "2026-09-10", isTestData: true, vendorName: "TEST-Acme" } });
    const line = await seedLineItem(id, { manualQbAccount: "60", totalPriceCents: big });
    await seedApproval(id, line, { ownerId: 7, status: "approved" });
    await signAllLines(id);
    await checkAndProcessExpense(ORG, id);
    expect(qbo.posts).toHaveLength(0);
    await db.expense.update({ where: { id }, data: { qbMatchState: "NEEDS_FINANCE" } });

    expect(await retryQbPost(ORG, id, { userId: 500 })).toBe(true);
    expect(qbo.posts).toHaveLength(0);
    expect((await expenseRow(id)).qbMatchState).toBe("POST_FAILED");
  });

  it("the cap measures the posted line sum, not the receipt total", async () => {
    const lines = await outboxed("2026-09-10", { amounts: [big - 300, 300] });
    await db.expense.update({ where: { id: lines.id }, data: { receiptTotalCents: 100 } });
    expect(await postExpenseToQb(ORG, lines.id)).toBe("queued");

    const receipt = await outboxed("2026-09-11");
    await db.expense.update({ where: { id: receipt.id }, data: { receiptTotalCents: big } });
    const other = await outboxed("2026-09-12");
    expect(await drainExpenseOutbox()).toMatchObject({ posted: 1, overCap: 1, capped: "cents" });
    expect((await expenseRow(lines.id)).qbMatchState).toBe("CREATED");
    expect(await drainExpenseOutbox()).toMatchObject({ posted: 2, overCap: 0, capped: null });
    expect((await expenseRow(receipt.id)).qbMatchState).toBe("CREATED");
    expect((await expenseRow(other.id)).qbMatchState).toBe("CREATED");
  });
});

describeDb("QB-2 posting — checks at post time", () => {
  it("re-checks the sign-off seats under the lock: a voided seat holds the post", async () => {
    const { id, lines } = await outboxed("2026-09-10");
    await db.expenseLineSignoff.deleteMany({ where: { lineItemId: lines[0], seat: "TREASURER" } });

    expect(await postExpenseToQb(ORG, id)).toBe("waiting");
    expect(await drainExpenseOutbox()).toMatchObject({ posted: 0, waiting: 1 });
    expect(qbo.posts).toHaveLength(0);
    expect((await expenseRow(id)).qbMatchState).toBe("UNMATCHED");
  });

  it("an unknown reimbursee holds the post", async () => {
    const { id } = await outboxed("2026-09-10", { reimburseePersonId: 42 });
    await db.expense.update({ where: { id }, data: { reimburseePersonId: null } });

    expect(await postExpenseToQb(ORG, id)).toBe("waiting");
    expect(qbo.posts).toHaveLength(0);
  });
});

describeDb("QB-2 posting — claim, call, settle", () => {
  /** Holds QuickBooks mid-call until the returned release runs. */
  function holdQbo() {
    let release!: () => void;
    qbo.gate = new Promise((r) => { release = r; });
    return () => { qbo.gate = null; release(); };
  }

  async function untilFetched() {
    while (vi.mocked(fetch).mock.calls.length === 0) await new Promise((r) => setTimeout(r, 5));
  }

  it("holds no row lock during the QuickBooks call, and the row reads POSTING meanwhile", async () => {
    const { id } = await outboxed("2026-09-10");
    const release = holdQbo();
    const post = postExpenseToQb(ORG, id);
    await untilFetched();

    const locked = await db.$transaction((tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM expenses WHERE id = ${id} FOR UPDATE NOWAIT`);
    expect(locked).toHaveLength(1);
    expect((await expenseRow(id)).qbMatchState).toBe("POSTING");

    release();
    expect(await post).toBe("posted");
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "CREATED", qbClaimedAt: null });
  });

  it("a retry cannot rewrite the payload while a post is in flight", async () => {
    const { id } = await outboxed("2026-09-10");
    await db.expense.update({ where: { id }, data: { qbMatchState: "POST_FAILED" } });
    const before = (await db.expenseEvent.findFirstOrThrow({ where: { expenseId: id } })).payload;
    const release = holdQbo();
    const post = postExpenseToQb(ORG, id);
    await untilFetched();

    expect(await retryQbPost(ORG, id, { userId: 500 })).toBe(false);
    expect((await db.expenseEvent.findFirstOrThrow({ where: { expenseId: id } })).payload).toBe(before);

    release();
    expect(await post).toBe("posted");
    expect(qbo.posts).toHaveLength(1);
  });

  it("a fresh claim is left alone by the request path and the drain", async () => {
    const { id } = await outboxed("2026-09-10");
    await db.expense.update({ where: { id }, data: { qbMatchState: "POSTING", qbClaimedAt: new Date() } });

    expect(await postExpenseToQb(ORG, id)).toBe("waiting");
    expect(await drainExpenseOutbox()).toMatchObject({ posted: 0 });
    expect(qbo.posts).toHaveLength(0);
  });

  it("a stale claim whose call did create the entry is taken over by key, never booked twice", async () => {
    const { id } = await outboxed("2026-09-10");
    expect(await postExpenseToQb(ORG, id)).toBe("posted");
    const created = qbo.purchases[0].Id;
    // The process died after QuickBooks created the entry and before the settle committed.
    await db.expense.update({
      where: { id },
      data: { qbMatchState: "POSTING", qbClaimedAt: new Date(Date.now() - STALE_CLAIM_MS - 1000), qbTxnId: null, qbTxnEntity: null },
    });
    await db.expenseQbClaim.deleteMany({ where: { orgId: ORG, qbTxnId: created } });

    expect(await drainExpenseOutbox()).toMatchObject({ posted: 1 });
    expect(qbo.posts).toHaveLength(1);
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "CREATED", qbTxnId: created, qbClaimedAt: null });
  });
});

describeDb("QB-2 posting — drain failure streak", () => {
  it("stops after consecutive failures, leaving the rest for the next run", async () => {
    const ids = [];
    for (let d = 10; d < 10 + MAX_CONSECUTIVE_FAILURES + 2; d++) ids.push((await outboxed(`2026-09-${d}`)).id);
    qbo.mode = "down";

    expect(await drainExpenseOutbox()).toMatchObject({ failed: MAX_CONSECUTIVE_FAILURES, stoppedAfterFailures: true });
    const states = await Promise.all(ids.map(async (id) => (await expenseRow(id)).qbMatchState));
    expect(states.filter((s) => s === "POST_FAILED")).toHaveLength(MAX_CONSECUTIVE_FAILURES);
    expect(states.filter((s) => s === "UNMATCHED")).toHaveLength(2);
  });
});

describeDb("QB-2 posting — a line's account after posting", () => {
  const finance = principal(500, { isFinance: true });

  it.each(["POSTING", "CREATED", "MATCHED"])("refuses to set a line's account once the expense is %s", async (qbMatchState) => {
    const { id, lines } = await outboxed("2026-09-10");
    await db.expense.update({ where: { id }, data: { qbMatchState } });

    await expect(setHeldLineAccount(finance, id, lines[0], "62")).rejects.toMatchObject({
      statusCode: 409,
      message: "already posted to QuickBooks; correct it there",
    });
    expect((await db.expenseLineItem.findUniqueOrThrow({ where: { id: lines[0] } })).manualQbAccount).toBeNull();
    expect(await db.expenseAuditLog.count({ where: { expenseId: id, action: "hold_account_set" } })).toBe(0);
  });

  it("allows and audits it before the expense is in QuickBooks", async () => {
    const { id, lines } = await outboxed("2026-09-10");
    await db.expense.update({ where: { id }, data: { qbMatchState: "POST_FAILED" } });

    await setHeldLineAccount(finance, id, lines[0], "62");
    expect((await db.expenseLineItem.findUniqueOrThrow({ where: { id: lines[0] } })).manualQbAccount).toBe("62");
    expect(await db.expenseAuditLog.count({ where: { expenseId: id, action: "hold_account_set" } })).toBe(1);
  });
});

describeDb("QB-2 posting — QuickBooks Class per line", () => {
  const classesOf = (n: number) => qbo.posts[n].body.Line.map((l) => l.AccountBasedExpenseLineDetail.ClassRef?.value);

  /** TEST_BUCKETS with bucket 100's Class taken away. */
  async function bucket100Unclassed() {
    const buckets = (await TEST_BUCKETS.list()).map((b) => (b.id === 100 ? { ...b, quickBooksClassId: null } : b));
    bindPorts({ budgetOwners: { list: async () => buckets }, quickbooks: { posting: posting() } });
  }

  it("every Purchase and Bill line posts with its bucket's Class", async () => {
    await handMatched("2026-08-01");
    await db.expenseReimburseeVendor.create({ data: { orgId: ORG, reimburseePersonId: 42, qbVendorId: VENDOR } });
    const purchase = await outboxed("2026-09-10");
    const bill = await outboxed("2026-09-11", { reimburseePersonId: 42, buckets: [200, 7] });

    expect(await postExpenseToQb(ORG, purchase.id)).toBe("posted");
    expect(await postExpenseToQb(ORG, bill.id)).toBe("posted");
    expect(classesOf(0)).toEqual(["97", "9100"]);
    expect(qbo.posts[1].entity).toBe("Bill");
    expect(classesOf(1)).toEqual(["9200", "97"]);
  });

  it("an event without bucketIds takes each line's current bucket", async () => {
    await handMatched("2026-08-01");
    const { id, lines } = await outboxed("2026-09-10", { buckets: [null, null] });
    await seedApproval(id, lines[0], { ownerId: 101, status: "approved" });
    await seedApproval(id, lines[1], { ownerId: 200, status: "approved" });

    expect(await postExpenseToQb(ORG, id)).toBe("posted");
    expect(classesOf(0)).toEqual(["9101", "9200"]);
  });

  it("a line whose bucket has no Class is not posted: state stays postable, no attempt counted, finance flagged", async () => {
    await handMatched("2026-08-01");
    await bucket100Unclassed();
    const { id } = await outboxed("2026-09-10");

    expect(await drainExpenseOutbox()).toMatchObject({ posted: 0, failed: 0, no_class: 1 });
    expect(qbo.posts).toHaveLength(0);
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "UNMATCHED", qbTxnId: null, qbPostAttempts: 0 });
    const flags = await db.expenseFlag.findMany({ where: { expenseId: id } });
    expect(flags.map((f) => [f.kind, f.audience, f.detail])).toEqual([
      ["QB_NO_CLASS", "FINANCE", "Budget bucket 'bucket-100' has no QuickBooks Class; set it on the Budgets page"],
    ]);
  });

  it("a line with no bucket at all is not posted and is flagged", async () => {
    await handMatched("2026-08-01");
    const { id } = await outboxed("2026-09-10", { buckets: [7, null] });

    expect(await postExpenseToQb(ORG, id)).toBe("no_class");
    expect(qbo.posts).toHaveLength(0);
    expect((await db.expenseFlag.findMany({ where: { expenseId: id } })).map((f) => f.kind)).toEqual(["QB_NO_CLASS"]);
  });

  it("an unclassed expense neither counts toward nor breaks the consecutive-failure stop", async () => {
    await handMatched("2026-08-01");
    await bucket100Unclassed();
    qbo.mode = "down";
    await outboxed("2026-09-10", { buckets: [7, 7] });
    await outboxed("2026-09-11");
    for (let d = 12; d < 12 + MAX_CONSECUTIVE_FAILURES; d++) await outboxed(`2026-09-${d}`, { buckets: [7, 7] });

    expect(await drainExpenseOutbox()).toMatchObject({ failed: MAX_CONSECUTIVE_FAILURES, no_class: 1, stoppedAfterFailures: true });
  });

  it("an unclassed expense counts toward neither cap, so the rest of the run still posts", async () => {
    await handMatched("2026-08-01");
    await bucket100Unclassed();
    const unclassed = await outboxed("2026-09-01", { amounts: [MAX_CREATE_CENTS_PER_RUN, 300] });
    const classed = await outboxed("2026-09-10", { buckets: [7, 7] });

    expect(await drainExpenseOutbox()).toMatchObject({ posted: 1, no_class: 1, overCap: 0, capped: null });
    expect((await expenseRow(unclassed.id)).qbMatchState).toBe("UNMATCHED");
    expect((await expenseRow(classed.id)).qbMatchState).toBe("CREATED");
  });

  it("setting the bucket's Class lets the next drain post it", async () => {
    await handMatched("2026-08-01");
    await bucket100Unclassed();
    const { id } = await outboxed("2026-09-10");
    expect(await drainExpenseOutbox()).toMatchObject({ no_class: 1 });
    expect(await drainExpenseOutbox()).toMatchObject({ no_class: 1 });

    bindQbo();
    expect(await drainExpenseOutbox()).toMatchObject({ posted: 1, no_class: 0 });
    expect(classesOf(0)).toEqual(["97", "9100"]);
    expect((await expenseRow(id)).qbMatchState).toBe("CREATED");
  });
});
