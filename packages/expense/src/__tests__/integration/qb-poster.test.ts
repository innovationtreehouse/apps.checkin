/**
 * QB-2 write path: the outbox drains into QuickBooks through the real QuickBooksClient over an
 * in-memory QBO company. One entry per expense; match before create; the key makes a retry safe.
 */
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { QuickBooksClient, qbKey, type QboBill, type QboPurchase } from "@inventory/quickbooks";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, catalogResolving, seedExpense, seedLineItem, signAllLines, ORG } from "../helpers/seed";
import { checkAndProcessExpense } from "../../lib/expense-qb-processor";
import { drainExpenseOutbox, postExpenseToQb } from "../../lib/expense-qb-poster";
import { runExpenseCatchUp } from "../../services/sweeps";

const PAYMENT_ACCOUNT = "41";
const VENDOR = "77";

interface PostedLine {
  Amount: number;
  AccountBasedExpenseLineDetail: { AccountRef: { value: string } };
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
  private nextId = 5000;

  handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
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

/** An expense already in the outbox: lines on accounts 60 and 61, receipt dated `day`; test data from a TEST- vendor unless told otherwise. */
async function outboxed(
  day: string,
  opts: { reimburseePersonId?: number; amounts?: [number, number]; isTestData?: boolean; vendorName?: string } = {},
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
  const item = (lineItemId: number, cents: number, account: string) => ({
    lineItemId, description: "Widget", quantity: 1, unitPriceCents: cents, totalPriceCents: cents,
    allocatedTaxCents: 0, allocatedShippingCents: 0, allocatedDiscountCents: 0,
    isDelayed: false, isCapital: false, capitalOwnerId: null, depreciationYears: null, account,
  });
  const payload = {
    schemaVersion: 1, id, vendorName, receiptDate: day, receiptTotalCents: a + b, orgId: ORG,
    needsReimbursement: opts.reimburseePersonId !== undefined, reimbursementFor: null,
    reimburseePersonId: opts.reimburseePersonId ?? null,
    items: [item(l1, a, "60"), item(l2, b, "61")],
  };
  await db.expenseEvent.create({ data: { orgId: ORG, expenseId: id, payload: JSON.stringify(payload) } });
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
    await seedLineItem(id, { manualQbAccount: "60", totalPriceCents: 500 });
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
    const result = await runExpenseCatchUp();
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
