/**
 * QB-2 write path: the outbox drains into QuickBooks through the real QuickBooksClient over an
 * in-memory QBO company. One entry per expense; match before create; the key makes a retry safe.
 */
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { QuickBooksClient, qbKey, type QboBill, type QboPurchase } from "@checkin/quickbooks";
import { describeDb } from "../helpers/db";
import { inertOutbound, type Outbound } from "../../contract";
import type { Expense } from "../../db/schema";
import { db } from "../../db";
import { TEST_BUCKETS, bindPorts, catalogResolving, principal, seedApproval, seedExpense, seedLineItem, signAllLines, ORG } from "../helpers/seed";
import { checkAndProcessExpense, retryQbPost } from "../../lib/expense-qb-processor";
import { expenseReasons } from "../../services/reasonService";
import {
  MAX_CONSECUTIVE_FAILURES, MAX_CREATES_PER_DAY, MAX_POST_ATTEMPTS, STALE_CLAIM_MS, drainExpenseOutbox, postExpenseToQb, sweepExpenseQbStrays,
} from "../../lib/expense-qb-poster";
import { matchExpenseToQb } from "../../services/qbMatchService";
import { POSTED_CHECK_OFF } from "../../services/flagService";
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

/** Windowed and created-since Purchase/Bill reads, and Purchase/Bill creates. */
class FakeQbo {
  purchases: QboPurchase[] = [];
  bills: QboBill[] = [];
  /** When each entry was created through the API; entries a test pushes by hand predate every attempt. */
  createdAt = new Map<string, Date>();
  posts: { entity: string; key: string; body: PostedTxn }[] = [];
  mode: "ok" | "down" | "accept-then-drop" | "closed" = "ok";
  /** The books closing date Preferences reports. */
  closeDate: string | null = null;
  /** While set, every request waits on it: a QuickBooks call still in flight. */
  gate: Promise<void> | null = null;
  private nextId = 5000;

  handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (this.gate) await this.gate;
    const url = new URL(String(input));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { intuit_tid: "tid" } });
    if (this.mode === "down") return json({ Fault: { Error: [{ code: "3100" }] } }, 503);
    if ((init?.method ?? "GET") === "GET") {
      if (url.searchParams.get("query") === "SELECT * FROM Preferences") {
        return json({ QueryResponse: { Preferences: [{ AccountingInfoPrefs: this.closeDate ? { BookCloseDate: this.closeDate } : {} }] } });
      }
      const since = /FROM (Purchase|Bill) WHERE MetaData.CreateTime >= '([^']+)'/.exec(url.searchParams.get("query") ?? "");
      if (since) {
        const list = (since[1] === "Purchase" ? this.purchases : this.bills).filter((t) => (this.createdAt.get(t.Id)?.getTime() ?? 0) >= new Date(since[2]).getTime());
        return json({ QueryResponse: list.length ? { [since[1]]: list } : {} });
      }
      const m = /FROM (Purchase|Bill) WHERE TxnDate >= '([\d-]+)' AND TxnDate <= '([\d-]+)'/.exec(url.searchParams.get("query") ?? "");
      if (!m) throw new Error(`unexpected query ${url.search}`);
      const list = (m[1] === "Purchase" ? this.purchases : this.bills).filter((t) => t.TxnDate >= m[2] && t.TxnDate <= m[3]);
      return json({ QueryResponse: list.length ? { [m[1]]: list } : {} });
    }
    if (this.mode === "closed") return json({ Fault: { Error: [{ code: "6210" }] } }, 400);
    const entity = url.pathname.endsWith("/bill") ? "Bill" : "Purchase";
    const body = JSON.parse(String(init?.body)) as PostedTxn;
    this.posts.push({ entity, key: url.searchParams.get("requestid") ?? "", body });
    const Id = String(this.nextId++);
    const TotalAmt = body.Line.reduce((s, l) => s + Math.round(l.Amount * 100), 0) / 100;
    const row = { Id, TxnDate: body.TxnDate, TotalAmt, AccountRef: body.AccountRef, VendorRef: body.VendorRef, PrivateNote: body.PrivateNote };
    (entity === "Bill" ? this.bills : this.purchases).push(row);
    this.createdAt.set(Id, new Date());
    if (this.mode === "accept-then-drop") throw new Error("socket hang up");
    return json({ [entity]: { Id } });
  };
}

let qbo: FakeQbo;
let sweepAlerts: { orgId: string; since: Date }[];

const posting = (prod = false) => ({
  client: new QuickBooksClient({ current: async () => "tok" }, { env: "sandbox", realmId: "123" }),
  paymentAccountId: PAYMENT_ACCOUNT,
  paymentType: "CreditCard" as const,
  prod,
  sweepIncomplete: async (event: { orgId: string; since: Date }) => void sweepAlerts.push(event),
});

function bindQbo(prod?: boolean) {
  bindPorts({ quickbooks: { posting: async () => posting(prod) } });
}

/** Posting switched on at `at`; null leaves it off. Expenses seeded later count as submitted after it. */
async function switchedOn(at: Date | null) {
  await db.expenseOrgSettings.upsert({ where: { orgId: ORG }, create: { orgId: ORG, qbPostingOnAt: at }, update: { qbPostingOnAt: at } });
}

/** A hand-booked match dated `day`. */
async function handMatched(day: string) {
  const id = await seedExpense({ state: "qb_complete" });
  await db.expense.update({ where: { id }, data: { receiptDate: day, qbMatchState: "MATCHED", qbTxnId: `hand-${day}`, qbTxnEntity: "Purchase" } });
}

/**
 * An expense already in the outbox, every line signed: lines resolved to accounts 60 and 61 and approved
 * in buckets 7 and 100, receipt dated `day`; test data from a TEST- vendor unless told otherwise. A null
 * bucket leaves that line without an approval.
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
  for (const [line, account, bucket] of [[l1, "60", b1], [l2, "61", b2]] as const) {
    await db.expenseLineItem.update({
      where: { id: line },
      data: { resolvedQbAccount: account, allocatedTaxCents: 0, allocatedShippingCents: 0, allocatedDiscountCents: 0 },
    });
    if (bucket !== null) await seedApproval(id, line, { ownerId: bucket, status: "approved" });
  }
  await db.expenseEvent.create({ data: { orgId: ORG, expenseId: id } });
  await signAllLines(id);
  return { id, lines: [l1, l2] };
}

const expenseRow = (id: string) => db.expense.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  qbo = new FakeQbo();
  sweepAlerts = [];
  vi.stubGlobal("fetch", vi.fn(qbo.handle));
  bindQbo();
  // Switched on before any seeded expense, with no closing date: nothing dated before 2026 is created.
  if (process.env.EXPENSE_DATABASE_URL) await switchedOn(new Date("2026-01-01T00:00:00Z"));
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
      quickbooks: { posting: async () => posting() },
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

describeDb("QB-2 posting — outbound gateway", () => {
  it("builds the entry inside quickbooks.create from the rows the gateway passes", async () => {
    await handMatched("2026-08-01");
    const { id } = await outboxed("2026-09-10");
    const calls: { surface: string; models: string[] }[] = [];
    const withoutVendorName: Outbound = (surface, bag, send) => {
      calls.push({ surface, models: Object.keys(bag) });
      return send({ ...bag, Expense: { ...(bag.Expense as Expense), vendorName: undefined } });
    };
    bindPorts({ quickbooks: { posting: async () => posting() }, outbound: withoutVendorName });

    expect(await postExpenseToQb(ORG, id)).toBe("posted");

    expect(calls).toEqual([
      { surface: "quickbooks.create", models: ["Expense", "ExpenseLineItem", "LineItemOwnerApproval", "BudgetOwner", "ExpenseReimburseeVendor"] },
    ]);
    expect(qbo.posts[0].body.PrivateNote).not.toContain("TEST-Acme");
  });

  it("a gateway that refuses sends nothing and records the failure", async () => {
    await handMatched("2026-08-01");
    const { id } = await outboxed("2026-09-10");
    bindPorts({ quickbooks: { posting: async () => posting() }, outbound: inertOutbound });

    expect(await postExpenseToQb(ORG, id)).toBe("failed");
    expect(qbo.posts).toHaveLength(0);
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "POST_FAILED", qbPostAttempts: 1 });
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
    expect(JSON.parse((await expenseRow(id)).qbMatchBaseline ?? "null")).toEqual({ amountCents: 1000, vendorId: null, txnDate: "2026-09-12" });
    expect((await expenseRow(id)).qbCreateAttemptedAt).not.toBeNull();
  });

  it("with posting off and no closing date nothing is created: the expense goes to finance as UNBOOKED", async () => {
    await switchedOn(null);
    const { id } = await outboxed("2026-09-10");

    expect(await postExpenseToQb(ORG, id)).toBe("queued");
    expect(qbo.posts).toHaveLength(0);
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "UNBOOKED", qbCreateAttemptedAt: null });
  });

  it("an expense submitted after switch-on is created", async () => {
    const { id } = await outboxed("2026-09-10");
    expect(await postExpenseToQb(ORG, id)).toBe("posted");
  });

  it("an expense submitted before switch-on is only matched; with no match it goes to finance as UNBOOKED", async () => {
    const { id } = await outboxed("2026-09-10");
    await switchedOn(new Date(Date.now() + 60_000));

    expect(await postExpenseToQb(ORG, id)).toBe("queued");
    expect(qbo.posts).toHaveLength(0);
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "UNBOOKED", qbCreateAttemptedAt: null });
    expect((await expenseReasons(principal(500, { isFinance: true }), id)).map((r) => r.code)).toContain("QB_UNBOOKED");
  });

  it("an expense submitted before switch-on still matches a hand-booked entry", async () => {
    const { id } = await outboxed("2026-09-10");
    await switchedOn(new Date(Date.now() + 60_000));
    qbo.purchases.push({ Id: "900", TxnDate: "2026-09-10", TotalAmt: 10, AccountRef: { value: PAYMENT_ACCOUNT } });

    expect(await postExpenseToQb(ORG, id)).toBe("matched");
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "MATCHED", qbTxnId: "900" });
  });

  it("with no closing date, nothing dated before switch-on is created", async () => {
    const { id } = await outboxed("2025-12-31");

    expect(await postExpenseToQb(ORG, id)).toBe("queued");
    expect(qbo.posts).toHaveLength(0);
    expect((await expenseRow(id)).qbMatchState).toBe("UNBOOKED");
  });

  it("an unreadable closing date creates nothing and leaves the expense as it was", async () => {
    const { id } = await outboxed("2026-09-10");
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input).includes("Preferences") ? new Response("{}", { status: 500 }) : qbo.handle(input, init),
    );

    expect(await postExpenseToQb(ORG, id)).toBe("waiting");
    expect(qbo.posts).toHaveLength(0);
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "UNMATCHED", qbCreateAttemptedAt: null });
  });

  it("sends an expense dated on or before the books closing date to finance as UNBOOKED, with a flag when submitted after switch-on", async () => {
    const { id } = await outboxed("2026-09-10");
    qbo.closeDate = "2026-09-10";

    expect(await postExpenseToQb(ORG, id)).toBe("queued");
    expect(qbo.posts).toHaveLength(0);
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "UNBOOKED", qbCreateAttemptedAt: null });
    expect((await db.expenseFlag.findFirstOrThrow({ where: { expenseId: id } })).kind).toBe("QB_POST_HELD");
  });

  it("a books closing date before the expense still lets it be created", async () => {
    await handMatched("2026-08-01");
    const { id } = await outboxed("2026-09-10");
    qbo.closeDate = "2026-08-31";

    expect(await postExpenseToQb(ORG, id)).toBe("posted");
    expect(qbo.posts).toHaveLength(1);
    expect((await expenseRow(id)).qbMatchState).toBe("CREATED");
  });

  it("re-reads the books closing date before the create and holds an expense it covers as UNBOOKED", async () => {
    const { id } = await outboxed("2026-09-10");
    // The run read no closing date; finance closes the period before the create.
    const close = { ok: true as const, date: null };
    qbo.closeDate = "2026-09-30";

    expect(await postExpenseToQb(ORG, id, { close })).toBe("queued");
    expect(qbo.posts).toHaveLength(0);
    expect((await expenseRow(id)).qbMatchState).toBe("UNBOOKED");
  });

  it("a create QuickBooks refuses as a closed period is held as UNBOOKED, never POST_FAILED", async () => {
    const { id } = await outboxed("2026-09-10");
    qbo.mode = "closed";

    expect(await postExpenseToQb(ORG, id)).toBe("queued");
    expect((await expenseRow(id)).qbMatchState).toBe("UNBOOKED");
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
    bindQbo(true);
    const { id } = await outboxed("2026-09-10");

    expect(await postExpenseToQb(ORG, id)).toBe("not_sent");
    expect(await drainExpenseOutbox()).toMatchObject({ posted: 0, not_sent: 1 });
    expect(qbo.posts).toHaveLength(0);
    expect((await expenseRow(id)).qbMatchState).toBe("TEST_DATA_REFUSED");
  });

  it("in prod, a real expense posts", async () => {
    bindQbo(true);
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

  it("an entry it created that is already claimed goes to finance as AMBIGUOUS with a duplicate-to-void review", async () => {
    await handMatched("2026-08-01");
    const { id } = await outboxed("2026-09-10");
    // The fake company hands out 5000 next; a claim on it stands in for one written mid-post.
    await db.expenseQbClaim.create({ data: { orgId: ORG, qbTxnEntity: "Purchase", qbTxnId: "5000" } });

    expect(await postExpenseToQb(ORG, id)).toBe("queued");
    expect(qbo.posts).toHaveLength(1);
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "AMBIGUOUS", qbTxnId: null });
    expect(await db.expenseFlag.count({ where: { expenseId: id, kind: "QB_DUPLICATE_TO_VOID", checkedOffAt: null } })).toBe(1);
  });
});

describeDb("QB-2 posting — bounded retry", () => {
  /** Outboxed through the real processor on one manual line, so a finance retry can rebuild it. */
  async function outboxedManual(account: string) {
    bindPorts({ catalog: catalogResolving({}), quickbooks: { posting: async () => posting() } });
    const id = await seedExpense({ state: "qb_pending", receiptTotalCents: 500 });
    await db.expense.update({ where: { id }, data: { receiptDate: "2026-09-10", isTestData: true, vendorName: "TEST-Acme" } });
    const line = await seedLineItem(id, { manualQbAccount: account, totalPriceCents: 500 });
    await seedApproval(id, line, { ownerId: 7, status: "approved" });
    await signAllLines(id);
    await checkAndProcessExpense(ORG, id);
    return { id, line };
  }

  it("a permanent rejection stops at NEEDS_FINANCE after the attempt limit, raising no flag, and the drain stops calling QuickBooks", async () => {
    const { id } = await outboxedManual("not-an-account");
    expect((await expenseRow(id)).qbMatchState).toBe("POST_FAILED");

    for (let i = 1; i < MAX_POST_ATTEMPTS; i++) await drainExpenseOutbox();
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "NEEDS_FINANCE", qbPostAttempts: MAX_POST_ATTEMPTS });
    expect(await db.expenseFlag.count({ where: { expenseId: id } })).toBe(0);
    const notes = (await db.expenseAuditLog.findMany({ where: { expenseId: id, fieldChanged: "qbMatchState" }, orderBy: { id: "asc" } })).map((a) => a.notes);
    expect(notes).toHaveLength(MAX_POST_ATTEMPTS);
    expect(notes.at(-1)).toMatch(new RegExp(`^attempt ${MAX_POST_ATTEMPTS} of ${MAX_POST_ATTEMPTS}: `));

    const windowReads = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("TxnDate")).length;
    const reads = windowReads();
    expect(await drainExpenseOutbox()).toMatchObject({ posted: 0, failed: 0 });
    expect(windowReads()).toBe(reads);
  });

  it("finance fixes the account and retries: the account is re-resolved, the expense posts and the posting reason clears", async () => {
    const { id, line } = await outboxedManual("not-an-account");
    for (let i = 1; i < MAX_POST_ATTEMPTS; i++) await drainExpenseOutbox();
    expect((await expenseRow(id)).qbMatchState).toBe("NEEDS_FINANCE");

    const finance = principal(500, { isFinance: true });
    await setHeldLineAccount(finance, id, line, "60");
    await resubmitHeldExpense(finance, id);

    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "CREATED", qbPostAttempts: 0 });
    expect((await expenseReasons(finance, id)).map((r) => r.code)).not.toContain("QB_POST_FAILED");
    expect(qbo.posts).toHaveLength(1);
    expect(qbo.posts[0].body.Line[0].AccountBasedExpenseLineDetail.AccountRef).toEqual({ value: "60" });
  });

  it("an error thrown inside the post counts as an attempt, so it too stops at NEEDS_FINANCE", async () => {
    await handMatched("2026-08-01");
    const { id } = await outboxed("2026-09-10");
    // Another expense already holding the entry id QuickBooks hands out makes the settle throw after QuickBooks answers.
    const holder = await seedExpense({ state: "qb_complete", backfill: true });
    await db.expense.update({ where: { id: holder }, data: { qbTxnEntity: "Purchase", qbTxnId: "5000" } });

    expect(await postExpenseToQb(ORG, id)).toBe("failed");
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "POST_FAILED", qbPostAttempts: 1, qbTxnId: null });

    // The retry finds the app's own entry, held by the other expense: finance decides, nothing is created again.
    expect(await drainExpenseOutbox()).toMatchObject({ needs_finance: 1 });
    expect((await expenseRow(id)).qbMatchState).toBe("NEEDS_FINANCE");
    const last = await db.expenseAuditLog.findFirstOrThrow({ where: { expenseId: id, action: "qb_needs_finance" } });
    expect(last.notes).toBe(`app entry Purchase 5000 is held by expense ${holder}`);
    expect(qbo.posts).toHaveLength(1);
  });

  it("a retry that fails again goes back to retrying, raising no flag", async () => {
    const { id } = await outboxedManual("not-an-account");
    for (let i = 1; i < MAX_POST_ATTEMPTS; i++) await drainExpenseOutbox();
    await resubmitHeldExpense(principal(500, { isFinance: true }), id);

    expect((await expenseRow(id)).qbMatchState).toBe("POST_FAILED");
    expect(await db.expenseFlag.count({ where: { expenseId: id } })).toBe(0);
  });

  it("a refused retry answers 409 and records no retry", async () => {
    const { id, line } = await outboxedManual("not-an-account");
    for (let i = 1; i < MAX_POST_ATTEMPTS; i++) await drainExpenseOutbox();
    await db.expenseLineItem.update({ where: { id: line }, data: { manualQbAccount: null } });

    await expect(resubmitHeldExpense(principal(500, { isFinance: true }), id)).rejects.toMatchObject({ status: 409 });

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
});

describeDb("QB-2 posting — no dollar cap", () => {
  const large = 2_500_100;

  it("an expense over $25,000 posts in an ordinary run beside the others, raising no flag", async () => {
    const small = await outboxed("2026-09-01");
    const big = await outboxed("2026-09-10", { amounts: [large - 300, 300] });
    const after = await outboxed("2026-09-11");

    expect(await drainExpenseOutbox()).toMatchObject({ posted: 3, capped: null });
    for (const { id } of [small, big, after]) expect((await expenseRow(id)).qbMatchState).toBe("CREATED");
    expect(await db.expenseFlag.count({ where: { expenseId: big.id } })).toBe(0);
  });

  it("a request-path post of a large expense posts", async () => {
    const { id } = await outboxed("2026-09-10", { amounts: [large - 300, 300] });
    expect(await postExpenseToQb(ORG, id)).toBe("posted");
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
    bindPorts({ catalog: catalogResolving({}), quickbooks: { posting: async () => posting() } });
    const id = await seedExpense({ state: "qb_pending", receiptTotalCents: 500 });
    await db.expense.update({ where: { id }, data: { receiptDate: "2026-09-10", isTestData: true, vendorName: "TEST-Acme" } });
    await seedLineItem(id, { manualQbAccount: "60", totalPriceCents: 500 });
    await signAllLines(id);

    await checkAndProcessExpense(ORG, id);

    expect(qbo.posts).toHaveLength(0);
    expect(await expenseRow(id)).toMatchObject({ state: "qb_complete", qbMatchState: "UNMATCHED", qbPostAttempts: 0 });
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
    expect(await db.expenseFlag.findMany({ where: { expenseId: id }, select: { kind: true, audience: true, detail: true } })).toEqual([
      { kind: "QB_POST_HELD", audience: "FINANCE", detail: "closed but not posted: a line is missing a sign-off seat" },
    ]);

    await db.expenseFlag.updateMany({ where: { expenseId: id }, data: { checkedOffAt: new Date(), checkedOffByUserId: 3 } });
    expect(await drainExpenseOutbox()).toMatchObject({ waiting: 1 });
    expect((await db.expenseFlag.findFirstOrThrow({ where: { expenseId: id } })).checkedOffAt).not.toBeNull();
  });

  it("a held flag still open when the expense posts is checked off by the post", async () => {
    const { id, lines } = await outboxed("2026-09-10");
    await db.expenseLineSignoff.deleteMany({ where: { lineItemId: lines[0], seat: "TREASURER" } });
    expect(await postExpenseToQb(ORG, id)).toBe("waiting");

    await db.expenseLineSignoff.create({ data: { expenseId: id, lineItemId: lines[0], seat: "TREASURER", signerUserId: 9002 } });
    expect(await postExpenseToQb(ORG, id)).toBe("posted");

    expect(await db.expenseFlag.findFirstOrThrow({ where: { expenseId: id, kind: "QB_POST_HELD" } })).toMatchObject({
      checkedOffByUsername: "system",
      notes: POSTED_CHECK_OFF,
    });
    expect(await db.expenseAuditLog.count({ where: { expenseId: id, action: "flag_checked_off", valueAfter: "QB_POST_HELD" } })).toBe(1);
  });

  it("a checked-off held flag reopens when the hold's reason changes", async () => {
    const { id, lines } = await outboxed("2026-09-10");
    await db.expenseLineSignoff.deleteMany({ where: { lineItemId: lines[0], seat: "TREASURER" } });
    expect(await postExpenseToQb(ORG, id)).toBe("waiting");
    await db.expenseFlag.updateMany({ where: { expenseId: id }, data: { checkedOffAt: new Date(), checkedOffByUserId: 3 } });

    await db.expenseLineSignoff.create({ data: { expenseId: id, lineItemId: lines[0], seat: "TREASURER", signerUserId: 9002 } });
    await db.lineItemOwnerApproval.updateMany({ where: { expenseId: id }, data: { status: "pending" } });
    expect(await postExpenseToQb(ORG, id)).toBe("waiting");

    expect(await db.expenseFlag.findMany({ where: { expenseId: id }, select: { detail: true, checkedOffAt: true } })).toEqual([
      { detail: "closed but not posted: a line is not approved: it is pending, under exception, waiting for its new bucket's approver, or rejected", checkedOffAt: null },
    ]);
  });

  it("a hold on an expense not yet closed waits without a flag", async () => {
    const { id, lines } = await outboxed("2026-09-10");
    await db.expense.update({ where: { id }, data: { state: "qb_pending" } });
    await db.expenseLineSignoff.deleteMany({ where: { lineItemId: lines[0], seat: "TREASURER" } });

    expect(await postExpenseToQb(ORG, id)).toBe("waiting");
    expect(qbo.posts).toHaveLength(0);
    expect(await db.expenseFlag.count({ where: { expenseId: id } })).toBe(0);
  });

  it.each(["rejected", "exception_raised", "pending", "finance_assigned"])("a line approval that turns %s after the outbox holds the post", async (status) => {
    const { id, lines } = await outboxed("2026-09-10", { buckets: [null, null] });
    await seedApproval(id, lines[0], { ownerId: 7, status: "approved" });
    const late = await seedApproval(id, lines[1], { ownerId: 100, status: "approved" });
    await db.lineItemOwnerApproval.update({ where: { id: late }, data: { status } });

    expect(await postExpenseToQb(ORG, id)).toBe("waiting");
    expect(await drainExpenseOutbox()).toMatchObject({ posted: 0, waiting: 1 });
    expect(qbo.posts).toHaveLength(0);
    expect((await db.expenseFlag.findFirstOrThrow({ where: { expenseId: id } })).kind).toBe("QB_POST_HELD");

    await db.lineItemOwnerApproval.update({ where: { id: late }, data: { status: "approved" } });
    expect(await postExpenseToQb(ORG, id)).toBe("posted");
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
    const post = postExpenseToQb(ORG, id, { close: { ok: true, date: null } });
    await untilFetched();

    const locked = await db.$transaction((tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM expenses WHERE id = ${id} FOR UPDATE NOWAIT`);
    expect(locked).toHaveLength(1);
    expect((await expenseRow(id)).qbMatchState).toBe("POSTING");

    release();
    expect(await post).toBe("posted");
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "CREATED", qbClaimedAt: null });
  });

  it("a retry cannot re-resolve the accounts while a post is in flight", async () => {
    const { id, lines } = await outboxed("2026-09-10");
    await db.expense.update({ where: { id }, data: { qbMatchState: "POST_FAILED" } });
    const accounts = () => db.expenseLineItem.findMany({ where: { id: { in: lines } }, orderBy: { id: "asc" }, select: { resolvedQbAccount: true } });
    const before = await accounts();
    const release = holdQbo();
    const post = postExpenseToQb(ORG, id, { close: { ok: true, date: null } });
    await untilFetched();

    expect(await retryQbPost(ORG, id, { userId: 500 })).toBe(false);
    expect(await accounts()).toEqual(before);

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
      status: 409,
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
    bindPorts({ budgetOwners: { list: async () => buckets }, quickbooks: { posting: async () => posting() } });
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

  it("each line posts with the Class of the bucket it is in now", async () => {
    await handMatched("2026-08-01");
    const { id, lines } = await outboxed("2026-09-10", { buckets: [null, null] });
    await seedApproval(id, lines[0], { ownerId: 101, status: "approved" });
    await seedApproval(id, lines[1], { ownerId: 200, status: "approved" });

    expect(await postExpenseToQb(ORG, id)).toBe("posted");
    expect(classesOf(0)).toEqual(["9101", "9200"]);
  });

  it("a line whose bucket has no Class is not posted: state stays postable, no attempt counted, no flag raised", async () => {
    await handMatched("2026-08-01");
    await bucket100Unclassed();
    const { id } = await outboxed("2026-09-10");

    expect(await drainExpenseOutbox()).toMatchObject({ posted: 0, failed: 0, no_class: 1 });
    expect(qbo.posts).toHaveLength(0);
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "UNMATCHED", qbTxnId: null, qbPostAttempts: 0 });
    expect(await db.expenseFlag.count({ where: { expenseId: id } })).toBe(0);
  });

  it("a line with no bucket at all is not posted", async () => {
    await handMatched("2026-08-01");
    const { id } = await outboxed("2026-09-10", { buckets: [7, null] });

    expect(await postExpenseToQb(ORG, id)).toBe("no_class");
    expect(qbo.posts).toHaveLength(0);
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

  it("an unclassed expense does not count toward the run cap, so the rest of the run still posts", async () => {
    await handMatched("2026-08-01");
    await bucket100Unclassed();
    const unclassed = await outboxed("2026-09-01");
    const classed = await outboxed("2026-09-10", { buckets: [7, 7] });

    expect(await drainExpenseOutbox()).toMatchObject({ posted: 1, no_class: 1, capped: null });
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

describeDb("QB-2 posting — a line outboxed without a resolved account", () => {
  it("fails the attempt, and nothing reaches QuickBooks", async () => {
    await handMatched("2026-08-01");
    const { id, lines } = await outboxed("2026-09-10");
    await db.expenseLineItem.update({ where: { id: lines[0] }, data: { resolvedQbAccount: null } });

    expect(await postExpenseToQb(ORG, id)).toBe("failed");
    expect(qbo.posts).toHaveLength(0);
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "POST_FAILED", qbPostAttempts: 1 });
  });
});

describeDb("QB closed books — book it", () => {
  const finance = principal(500, { isFinance: true });

  it("finance books an UNBOOKED expense: the app creates it, matching first", async () => {
    const { id } = await outboxed("2026-09-10");
    await switchedOn(new Date(Date.now() + 60_000));
    qbo.closeDate = "2026-06-30";
    expect(await postExpenseToQb(ORG, id)).toBe("queued");

    await resubmitHeldExpense(finance, id);

    expect(qbo.posts).toHaveLength(1);
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "CREATED", qbTxnId: qbo.purchases[0].Id });
    expect((await expenseRow(id)).qbCreateAttemptedAt).not.toBeNull();
    expect(await db.expenseAuditLog.count({ where: { expenseId: id, action: "qb_book_requested", userId: 500 } })).toBe(1);
  });

  it("a BEFORE_LINE expense is booked exactly as UNBOOKED", async () => {
    const { id } = await outboxed("2026-09-10");
    await db.expense.update({ where: { id }, data: { qbMatchState: "BEFORE_LINE" } });
    expect(await drainExpenseOutbox()).toMatchObject({ posted: 0 });

    await resubmitHeldExpense(finance, id);
    expect((await expenseRow(id)).qbMatchState).toBe("CREATED");
  });

  it("refuses to book into closed books, and the expense stays UNBOOKED", async () => {
    const { id } = await outboxed("2026-09-10");
    await db.expense.update({ where: { id }, data: { qbMatchState: "UNBOOKED" } });
    qbo.closeDate = "2026-09-30";

    await expect(resubmitHeldExpense(finance, id)).rejects.toMatchObject({ status: 409 });
    expect(qbo.posts).toHaveLength(0);
    expect((await expenseRow(id)).qbMatchState).toBe("UNBOOKED");
  });

  it("refuses with no closing date while posting is off", async () => {
    await switchedOn(null);
    const { id } = await outboxed("2026-09-10");
    await db.expense.update({ where: { id }, data: { qbMatchState: "UNBOOKED" } });

    await expect(resubmitHeldExpense(finance, id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("closing date") });
    expect(qbo.posts).toHaveLength(0);
  });

  it("answers 503 when the closing date cannot be read", async () => {
    const { id } = await outboxed("2026-09-10");
    await db.expense.update({ where: { id }, data: { qbMatchState: "UNBOOKED" } });
    qbo.mode = "down";

    await expect(resubmitHeldExpense(finance, id)).rejects.toMatchObject({ status: 503 });
  });

  it("still needs every sign-off", async () => {
    const { id, lines } = await outboxed("2026-09-10");
    await db.expense.update({ where: { id }, data: { qbMatchState: "UNBOOKED" } });
    await db.expenseLineSignoff.deleteMany({ where: { lineItemId: lines[0], seat: "TREASURER" } });

    await expect(resubmitHeldExpense(finance, id)).rejects.toMatchObject({ status: 409 });
    expect(qbo.posts).toHaveLength(0);
  });

  it("the drain never books an UNBOOKED expense on its own", async () => {
    const { id } = await outboxed("2026-09-10");
    await db.expense.update({ where: { id }, data: { qbMatchState: "UNBOOKED" } });

    expect(await drainExpenseOutbox()).toMatchObject({ posted: 0 });
    expect(qbo.posts).toHaveLength(0);
  });
});

describeDb("QB closed books — switch-on", () => {
  it("the first connected drain stamps switch-on once and never moves it", async () => {
    await db.expenseOrgSettings.deleteMany();
    const first = new Date("2026-10-01T00:00:00Z");
    await drainExpenseOutbox(first);
    await drainExpenseOutbox(new Date("2026-10-02T00:00:00Z"));

    expect((await db.expenseOrgSettings.findUniqueOrThrow({ where: { orgId: ORG } })).qbPostingOnAt).toEqual(first);
    expect(await db.expenseOrgSettingsChange.count({ where: { orgId: ORG } })).toBe(1);
  });

  it("an unbound drain switches nothing on", async () => {
    await db.expenseOrgSettings.deleteMany();
    bindPorts({});
    expect(await drainExpenseOutbox()).toBe("unbound");
    expect(await db.expenseOrgSettings.count()).toBe(0);
  });
});

describeDb("QB closed books — a create that may have landed", () => {
  it("marks the attempt only when the post may create", async () => {
    const { id } = await outboxed("2026-09-10");
    await switchedOn(new Date(Date.now() + 60_000));
    await postExpenseToQb(ORG, id);
    expect((await expenseRow(id)).qbCreateAttemptedAt).toBeNull();
  });

  it("an attempted expense whose entry finance re-dated out of the window is found by key, never booked twice", async () => {
    const { id } = await outboxed("2026-09-10");
    qbo.mode = "accept-then-drop";
    expect(await postExpenseToQb(ORG, id)).toBe("failed");
    qbo.purchases[0].TxnDate = "2026-11-30";

    qbo.mode = "ok";
    expect(await postExpenseToQb(ORG, id)).toBe("posted");
    expect(qbo.posts).toHaveLength(1);
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "CREATED", qbTxnId: qbo.purchases[0].Id });
  });

  it("an attempted expense whose created-since read fails creates nothing and goes to finance", async () => {
    const { id } = await outboxed("2026-09-10");
    qbo.mode = "accept-then-drop";
    await postExpenseToQb(ORG, id);
    qbo.mode = "ok";
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input).includes("CreateTime") ? new Response("{}", { status: 500 }) : qbo.handle(input, init),
    );

    expect(await postExpenseToQb(ORG, id)).toBe("needs_finance");
    expect(qbo.posts).toHaveLength(1);
    expect((await expenseRow(id)).qbMatchState).toBe("NEEDS_FINANCE");
  });

  it("finance's match on an attempted expense links the app's own entry instead", async () => {
    const { id } = await outboxed("2026-09-10");
    qbo.mode = "accept-then-drop";
    await postExpenseToQb(ORG, id);
    const own = qbo.purchases[0].Id;
    await db.expense.update({ where: { id }, data: { qbMatchState: "UNBOOKED" } });

    await matchExpenseToQb(principal(500, { isFinance: true }), id, "hand-1");

    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "CREATED", qbTxnId: own, qbTxnEntity: "Purchase" });
    expect(await db.expenseQbClaim.count({ where: { orgId: ORG, qbTxnEntity: "Purchase", qbTxnId: own } })).toBe(1);
  });

  it("finance's match does not link the app's own entry while a sign-off is missing", async () => {
    const { id, lines } = await outboxed("2026-09-10");
    qbo.mode = "accept-then-drop";
    await postExpenseToQb(ORG, id);
    await db.expense.update({ where: { id }, data: { qbMatchState: "UNBOOKED" } });
    await db.expenseLineSignoff.deleteMany({ where: { lineItemId: lines[0], seat: "TREASURER" } });

    await expect(matchExpenseToQb(principal(500, { isFinance: true }), id, "hand-1")).rejects.toMatchObject({ status: 409 });
    expect(await expenseRow(id)).toMatchObject({ qbMatchState: "UNBOOKED", qbTxnId: null });
    expect(await db.expenseQbClaim.count({ where: { orgId: ORG } })).toBe(0);
  });

  it("finance's match is refused while the app's own entry is held by another expense", async () => {
    const { id } = await outboxed("2026-09-10");
    qbo.mode = "accept-then-drop";
    await postExpenseToQb(ORG, id);
    const holder = await seedExpense({ state: "qb_complete", backfill: true });
    await db.expense.update({ where: { id: holder }, data: { qbTxnEntity: "Purchase", qbTxnId: qbo.purchases[0].Id } });

    await expect(matchExpenseToQb(principal(500, { isFinance: true }), id, "hand-1")).rejects.toMatchObject({ status: 409 });
    expect((await expenseRow(id)).qbTxnId).toBeNull();
  });

  it("a post that lost its claim after creating raises a duplicate-to-void review with the entry's id", async () => {
    const { id } = await outboxed("2026-09-10");
    let release!: () => void;
    qbo.gate = new Promise((r) => { release = r; });
    const post = postExpenseToQb(ORG, id, { close: { ok: true, date: null } });
    while (vi.mocked(fetch).mock.calls.length === 0) await new Promise((r) => setTimeout(r, 5));
    // Another worker took the claim over meanwhile.
    await db.expense.update({ where: { id }, data: { qbClaimedAt: new Date(Date.now() + 1000) } });
    qbo.gate = null;
    release();

    expect(await post).toBe("waiting");
    const flag = await db.expenseFlag.findFirstOrThrow({ where: { expenseId: id, kind: "QB_DUPLICATE_TO_VOID" } });
    expect(flag.detail).toContain(`Purchase ${qbo.purchases[0].Id}`);
  });
});

describeDb("QB closed books — daily orphan sweep", () => {
  it("raises a duplicate-to-void review once for an app entry its expense does not hold", async () => {
    const { id } = await outboxed("2026-09-10");
    qbo.mode = "accept-then-drop";
    await postExpenseToQb(ORG, id);
    qbo.mode = "ok";
    await db.expense.update({ where: { id }, data: { qbMatchState: "NEEDS_FINANCE" } });

    expect(await sweepExpenseQbStrays(ORG, posting())).toEqual({ entries: 1, flagged: 1, full: false });
    expect(await sweepExpenseQbStrays(ORG, posting())).toEqual({ entries: 1, flagged: 0, full: false });
    const flag = await db.expenseFlag.findFirstOrThrow({ where: { expenseId: id, kind: "QB_DUPLICATE_TO_VOID" } });
    expect(flag.detail).toBe(`QuickBooks Purchase ${qbo.purchases[0].Id} carries this expense's key but is not linked to it; void it or link it`);
  });

  /** Checks off the expense's duplicate-to-void review as finance would. */
  const checkOffStray = (expenseId: string) =>
    db.expenseFlag.updateMany({ where: { expenseId, kind: "QB_DUPLICATE_TO_VOID" }, data: { checkedOffAt: new Date(), checkedOffByUserId: 3 } });

  it("an answered stray stays answered, and two strays on one expense do not take turns reopening it", async () => {
    const { id } = await outboxed("2026-09-10");
    qbo.mode = "accept-then-drop";
    await postExpenseToQb(ORG, id);
    qbo.mode = "ok";
    await db.expense.update({ where: { id }, data: { qbMatchState: "NEEDS_FINANCE" } });
    const [first] = qbo.purchases;
    expect(await sweepExpenseQbStrays(ORG, posting())).toMatchObject({ flagged: 1 });
    await checkOffStray(id);

    qbo.purchases.push({ ...first, Id: "7001" });
    qbo.createdAt.set("7001", new Date());
    expect(await sweepExpenseQbStrays(ORG, posting())).toMatchObject({ entries: 2, flagged: 1 });
    await checkOffStray(id);

    expect(await sweepExpenseQbStrays(ORG, posting())).toMatchObject({ entries: 2, flagged: 0 });
    expect(await sweepExpenseQbStrays(ORG, posting())).toMatchObject({ entries: 2, flagged: 0 });
    const flag = await db.expenseFlag.findFirstOrThrow({ where: { expenseId: id, kind: "QB_DUPLICATE_TO_VOID" } });
    expect(flag.checkedOffAt).not.toBeNull();
    expect(JSON.parse(flag.observed ?? "[]")).toEqual([`Purchase:${first.Id}`, "Purchase:7001"]);
  });

  it("a stray the post already raised is not raised again, before or after finance checks it off", async () => {
    await handMatched("2026-08-01");
    const { id } = await outboxed("2026-09-10");
    await db.expenseQbClaim.create({ data: { orgId: ORG, qbTxnEntity: "Purchase", qbTxnId: "5000" } });
    expect(await postExpenseToQb(ORG, id)).toBe("queued");

    expect(await sweepExpenseQbStrays(ORG, posting())).toMatchObject({ entries: 1, flagged: 0 });
    await checkOffStray(id);
    expect(await sweepExpenseQbStrays(ORG, posting())).toMatchObject({ entries: 1, flagged: 0 });
    expect((await db.expenseFlag.findFirstOrThrow({ where: { expenseId: id, kind: "QB_DUPLICATE_TO_VOID" } })).checkedOffAt).not.toBeNull();
  });

  it("a second stray while the review is open joins its detail", async () => {
    const { id } = await outboxed("2026-09-10");
    qbo.mode = "accept-then-drop";
    await postExpenseToQb(ORG, id);
    qbo.mode = "ok";
    await db.expense.update({ where: { id }, data: { qbMatchState: "NEEDS_FINANCE" } });
    qbo.purchases.push({ ...qbo.purchases[0], Id: "7001" });
    qbo.createdAt.set("7001", new Date());

    expect(await sweepExpenseQbStrays(ORG, posting())).toMatchObject({ flagged: 2 });
    const flag = await db.expenseFlag.findFirstOrThrow({ where: { expenseId: id, kind: "QB_DUPLICATE_TO_VOID" } });
    expect(flag.detail).toContain(`Purchase ${qbo.purchases[0].Id} `);
    expect(flag.detail).toContain("Purchase 7001 ");
  });

  it("alerts finance once when a read fills a page, and a failed alert does not stop the sweep", async () => {
    const { id } = await outboxed("2026-09-10");
    await postExpenseToQb(ORG, id);
    const attempted = (await expenseRow(id)).qbCreateAttemptedAt;
    for (let i = 0; i < 1000; i++) {
      qbo.purchases.push({ Id: `h${i}`, TxnDate: "2026-10-01", TotalAmt: 1, AccountRef: { value: PAYMENT_ACCOUNT } });
      qbo.createdAt.set(`h${i}`, new Date());
    }

    expect(await sweepExpenseQbStrays(ORG, posting())).toMatchObject({ full: true, flagged: 0 });
    expect(sweepAlerts).toEqual([{ orgId: ORG, since: attempted }]);

    const failing = { ...posting(), sweepIncomplete: async () => { throw new Error("SES down"); } };
    expect(await sweepExpenseQbStrays(ORG, failing)).toMatchObject({ full: true, flagged: 0 });
  });

  it("reports nothing for an entry its expense holds, and runs at the end of the drain", async () => {
    await outboxed("2026-09-10");
    expect(await drainExpenseOutbox()).toMatchObject({ posted: 1, sweep: { entries: 1, flagged: 0, full: false } });
  });

  it("reads nothing when no expense was attempted", async () => {
    expect(await sweepExpenseQbStrays(ORG, posting())).toEqual({ entries: 0, flagged: 0, full: false });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
