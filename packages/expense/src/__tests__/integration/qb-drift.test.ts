/**
 * QuickBooks drift: the cron step re-reads each app-created or matched QuickBooks entry through the windowed
 * readers, over an in-memory QBO company, and flags finance on edits. It only ever reads.
 */
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { QuickBooksClient, qbKey, type QboBill, type QboPurchase } from "@checkin/quickbooks";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, seedExpense, seedLineItem, ORG } from "../helpers/seed";
import { MAX_DRIFT_CHECKS_PER_RUN, baselineOf, checkQbDrift } from "../../lib/expense-qb-drift";
import { runExpenseQbPosting } from "../../services/sweeps";
import { raiseFlag } from "../../services/flagService";

const line = (amount: number, account: string) => ({ Amount: amount, AccountBasedExpenseLineDetail: { AccountRef: { value: account } } });

/** Windowed Purchase/Bill reads only; any other request fails the test. */
class FakeQbo {
  purchases: QboPurchase[] = [];
  bills: QboBill[] = [];
  down = false;
  methods: string[] = [];

  handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    this.methods.push(init?.method ?? "GET");
    if (this.down) return new Response(JSON.stringify({ Fault: { Error: [{ code: "3100" }] } }), { status: 503 });
    const m = /FROM (Purchase|Bill) WHERE TxnDate >= '([\d-]+)' AND TxnDate <= '([\d-]+)'/.exec(new URL(String(input)).searchParams.get("query") ?? "");
    if (!m) throw new Error(`unexpected request ${String(input)}`);
    const list = (m[1] === "Purchase" ? this.purchases : this.bills).filter((t) => t.TxnDate >= m[2] && t.TxnDate <= m[3]);
    return new Response(JSON.stringify({ QueryResponse: list.length ? { [m[1]]: list } : {} }), { status: 200, headers: { intuit_tid: "tid" } });
  };
}

let qbo: FakeQbo;
let nextQbId = 5000;

beforeEach(() => {
  qbo = new FakeQbo();
  vi.stubGlobal("fetch", vi.fn(qbo.handle));
  bindPorts({
    quickbooks: {
      posting: async () => ({
        client: new QuickBooksClient({ current: async () => "tok" }, { env: "sandbox", realmId: "123" }),
        paymentAccountId: "41",
        paymentType: "CreditCard",
        prod: false,
        sweepIncomplete: async () => {},
      }),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

/**
 * An expense the drain created in QuickBooks: lines of $7 on account 60 and $3 on 61, a Bill to
 * vendor 77 when `bill`, else a Purchase, dated on the receipt date as the drain posts it.
 */
async function created(day: string, opts: { bill?: boolean; state?: string } = {}) {
  const id = await seedExpense({ state: "qb_complete", receiptTotalCents: 1000, needsReimbursement: !!opts.bill, reimburseePersonId: opts.bill ? 9 : undefined });
  const l1 = await seedLineItem(id, { totalPriceCents: 700 });
  const l2 = await seedLineItem(id, { totalPriceCents: 300 });
  for (const [lineId, account] of [[l1, "60"], [l2, "61"]] as const) {
    await db.expenseLineItem.update({
      where: { id: lineId },
      data: { resolvedQbAccount: account, qbAccountId: account, allocatedTaxCents: 0, allocatedShippingCents: 0, allocatedDiscountCents: 0 },
    });
  }
  await db.expenseEvent.create({ data: { orgId: ORG, expenseId: id } });
  const qbId = String(nextQbId++);
  const entity = opts.bill ? "Bill" : "Purchase";
  await db.expense.update({
    where: { id },
    data: { receiptDate: day, qbMatchState: opts.state ?? "CREATED", qbTxnId: qbId, qbTxnEntity: entity, qbVendorId: opts.bill ? "77" : null },
  });
  const entry: QboBill = {
    Id: qbId,
    TxnDate: day,
    TotalAmt: 10,
    PrivateNote: `TEST-Acme\n[checkin:${qbKey("expense", id)}]`,
    Line: [line(7, "60"), line(3, "61")],
    ...(opts.bill ? { VendorRef: { value: "77" } } : { AccountRef: { value: "41" } }),
  };
  (opts.bill ? qbo.bills : qbo.purchases).push(entry);
  return { id, entry };
}

/**
 * An expense matched to finance's hand-booked Purchase: $10 on accounts 60 and 61, no app key.
 * The baseline is stored as at match unless `legacy`, a row matched before baselines existed.
 */
async function matched(day: string, opts: { legacy?: boolean } = {}) {
  const id = await seedExpense({ state: "qb_complete", receiptTotalCents: 1000 });
  const entry: QboPurchase = {
    Id: String(nextQbId++),
    TxnDate: day,
    TotalAmt: 10,
    PrivateNote: "hand-booked",
    AccountRef: { value: "41" },
    Line: [line(7, "60"), line(3, "61")],
  };
  qbo.purchases.push(entry);
  await db.expense.update({
    where: { id },
    data: {
      receiptDate: day, qbMatchState: "MATCHED", qbTxnId: entry.Id, qbTxnEntity: "Purchase",
      qbMatchBaseline: opts.legacy ? null : JSON.stringify(baselineOf(entry)),
    },
  });
  return { id, entry };
}

const baseline = async (id: string) => (await db.expense.findUniqueOrThrow({ where: { id } })).qbMatchBaseline;

const driftFlag = (expenseId: string) => db.expenseFlag.findFirst({ where: { expenseId, kind: "QB_DRIFT" } });
const checkOff = (expenseId: string) =>
  db.expenseFlag.updateMany({ where: { expenseId, kind: "QB_DRIFT" }, data: { checkedOffAt: new Date(), checkedOffByUserId: 5, checkedOffByUsername: "finance" } });

describeDb("QB-3 drift", () => {
  it("raises nothing for entries still as posted, and only reads QuickBooks", async () => {
    const { id } = await created("2026-09-10");
    const { id: billId } = await created("2026-09-11", { bill: true });

    expect(await checkQbDrift()).toEqual({ checked: 2, drifted: 0, failed: 0 });
    expect(await driftFlag(id)).toBeNull();
    expect(await driftFlag(billId)).toBeNull();
    expect(new Set(qbo.methods)).toEqual(new Set(["GET"]));
  });

  it("flags finance with the drifted field names, no amounts or ids", async () => {
    const { id, entry } = await created("2026-09-10", { bill: true });
    entry.TotalAmt = 12;
    entry.VendorRef = { value: "78" };
    entry.Line = [line(7, "60"), line(5, "62")];

    expect(await checkQbDrift()).toEqual({ checked: 1, drifted: 1, failed: 0 });
    expect(await driftFlag(id)).toMatchObject({ audience: "FINANCE", detail: "amount, accounts, vendor", checkedOffAt: null });
  });

  it("flags an entry deleted, or re-dated out of the window, as missing", async () => {
    const { id, entry } = await created("2026-09-10");
    entry.TxnDate = "2026-10-30";

    await checkQbDrift();
    expect(await driftFlag(id)).toMatchObject({ detail: "missing" });
  });

  it("flags an entry finance re-dated inside the window", async () => {
    const { id, entry } = await created("2026-09-10");
    entry.TxnDate = "2026-09-12";

    expect(await checkQbDrift()).toEqual({ checked: 1, drifted: 1, failed: 0 });
    expect(await driftFlag(id)).toMatchObject({ detail: "date" });
    expect(JSON.parse((await driftFlag(id))?.observed ?? "null")).toEqual({ date: "2026-09-12" });
  });

  it("flags a matched entry finance re-dated after the match", async () => {
    const { id, entry } = await matched("2026-09-10");
    entry.TxnDate = "2026-09-11";

    await checkQbDrift();
    expect(await driftFlag(id)).toMatchObject({ detail: "date" });
  });

  it("does not compare the date of a baseline stored without one", async () => {
    const { id, entry } = await matched("2026-09-10");
    await db.expense.update({ where: { id }, data: { qbMatchBaseline: JSON.stringify({ amountCents: 1000, accounts: ["60", "61"], vendorId: null }) } });
    entry.TxnDate = "2026-09-11";

    expect(await checkQbDrift()).toMatchObject({ drifted: 0 });
  });

  it("flags a memo edit that dropped the app key", async () => {
    const { id, entry } = await created("2026-09-10");
    entry.PrivateNote = "TEST-Acme";

    await checkQbDrift();
    expect(await driftFlag(id)).toMatchObject({ detail: "key" });
  });

  it("leaves drift finance checked off closed, and reopens on different drift", async () => {
    const { id, entry } = await created("2026-09-10");
    entry.TotalAmt = 12;
    await checkQbDrift();
    await checkOff(id);

    await checkQbDrift();
    expect((await driftFlag(id))?.checkedOffAt).not.toBeNull();

    entry.PrivateNote = "edited";
    await checkQbDrift();
    expect(await driftFlag(id)).toMatchObject({ detail: "amount, key", checkedOffAt: null });
  });

  it("keeps a check-off while QuickBooks shows the same values, and reopens on a further change to the same field", async () => {
    const { id, entry } = await created("2026-09-10");
    entry.TotalAmt = 10.01;
    await checkQbDrift();
    await checkOff(id);

    await checkQbDrift();
    expect((await driftFlag(id))?.checkedOffAt).not.toBeNull();

    entry.TotalAmt = 2010.01;
    await checkQbDrift();
    expect(await driftFlag(id)).toMatchObject({ detail: "amount", checkedOffAt: null });
    expect(JSON.parse((await driftFlag(id))?.observed ?? "null")).toEqual({ amount: 201001 });
  });

  it("checks a check-off against the values last seen before it", async () => {
    const { id, entry } = await created("2026-09-10");
    entry.TotalAmt = 10.01;
    await checkQbDrift();
    entry.TotalAmt = 2010.01;
    await checkQbDrift();
    await checkOff(id);

    await checkQbDrift();
    expect((await driftFlag(id))?.checkedOffAt).not.toBeNull();
  });

  it("keeps a check-off when finance only re-classes a line", async () => {
    const { id, entry } = await created("2026-09-10");
    entry.TotalAmt = 12;
    await checkQbDrift();
    await checkOff(id);

    entry.Line = entry.Line!.map((l) => ({ ...l, AccountBasedExpenseLineDetail: { ...l.AccountBasedExpenseLineDetail!, ClassRef: { value: "8" } } }));
    await checkQbDrift();
    expect((await driftFlag(id))?.checkedOffAt).not.toBeNull();
  });

  it("keeps the stay-closed rule to QB_DRIFT: a re-raised QB_POST_HELD review still reopens", async () => {
    const { id } = await created("2026-09-10");
    await raiseFlag(id, "QB_POST_HELD", "same detail");
    await db.expenseFlag.updateMany({ where: { expenseId: id, kind: "QB_POST_HELD" }, data: { checkedOffAt: new Date(), checkedOffByUserId: 5 } });

    await raiseFlag(id, "QB_POST_HELD", "same detail");
    expect(await db.expenseFlag.findFirst({ where: { expenseId: id, kind: "QB_POST_HELD" } })).toMatchObject({ checkedOffAt: null });
  });

  it("raises nothing for a matched entry still as it was at match", async () => {
    const { id } = await matched("2026-09-10");

    expect(await checkQbDrift()).toEqual({ checked: 1, drifted: 0, failed: 0 });
    expect(await driftFlag(id)).toBeNull();
  });

  it("flags a matched entry finance edited after the match", async () => {
    const { id, entry } = await matched("2026-09-10");
    entry.TotalAmt = 12;

    expect(await checkQbDrift()).toEqual({ checked: 1, drifted: 1, failed: 0 });
    expect(await driftFlag(id)).toMatchObject({ audience: "FINANCE", detail: "amount", checkedOffAt: null });
    expect(await db.expense.findUniqueOrThrow({ where: { id } })).toMatchObject({ qbMatchState: "MATCHED", qbTxnId: entry.Id });
  });

  it("flags a matched entry finance deleted as missing", async () => {
    const { id } = await matched("2026-09-10");
    qbo.purchases = [];

    await checkQbDrift();
    expect(await driftFlag(id)).toMatchObject({ detail: "missing" });
  });

  it("ignores a re-classed line on a matched entry", async () => {
    const { id, entry } = await matched("2026-09-10");
    entry.Line = entry.Line!.map((l) => ({ ...l, AccountBasedExpenseLineDetail: { ...l.AccountBasedExpenseLineDetail!, ClassRef: { value: "8" } } }));

    expect(await checkQbDrift()).toMatchObject({ drifted: 0 });
    expect(await driftFlag(id)).toBeNull();
  });

  it("takes a legacy matched row's baseline on first read, then checks against it", async () => {
    const { id, entry } = await matched("2026-09-10", { legacy: true });
    entry.TotalAmt = 11;

    expect(await checkQbDrift()).toEqual({ checked: 1, drifted: 0, failed: 0 });
    expect(await driftFlag(id)).toBeNull();
    expect(JSON.parse((await baseline(id)) ?? "null")).toEqual({ amountCents: 1100, accounts: ["60", "61"], vendorId: null, txnDate: "2026-09-10" });

    entry.TotalAmt = 12;
    await checkQbDrift();
    expect(await driftFlag(id)).toMatchObject({ detail: "amount" });
  });

  it("counts a QuickBooks outage as failed and raises nothing", async () => {
    const { id } = await created("2026-09-10");
    qbo.down = true;

    expect(await checkQbDrift()).toMatchObject({ checked: 0, failed: 1 });
    expect(await driftFlag(id)).toBeNull();
  });

  it("reads at most the cap per run", async () => {
    for (let i = 0; i < MAX_DRIFT_CHECKS_PER_RUN + 2; i++) await created("2026-09-10");

    expect(await checkQbDrift()).toMatchObject({ checked: MAX_DRIFT_CHECKS_PER_RUN });
    expect(qbo.methods).toHaveLength(MAX_DRIFT_CHECKS_PER_RUN);
  });

  it("is skipped while QuickBooks is unbound, and runs in the QuickBooks cron step", async () => {
    const { entry } = await created("2026-09-10");
    entry.TotalAmt = 12;

    expect((await runExpenseQbPosting()).qbDrift).toEqual({ checked: 1, drifted: 1, failed: 0 });
    bindPorts({});
    expect(await checkQbDrift()).toBe("unbound");
  });
});
