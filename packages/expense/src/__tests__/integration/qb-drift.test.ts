/**
 * QB-3 drift: the cron step re-reads each app-created QuickBooks entry through the windowed
 * readers, over an in-memory QBO company, and flags finance on edits. It only ever reads.
 */
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { QuickBooksClient, qbKey, type QboBill, type QboPurchase } from "@inventory/quickbooks";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { bindPorts, seedExpense, seedLineItem, ORG } from "../helpers/seed";
import { MAX_DRIFT_CHECKS_PER_RUN, checkQbDrift } from "../../lib/expense-qb-drift";
import { runExpenseCatchUp } from "../../services/sweeps";

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
      posting: {
        client: new QuickBooksClient({ current: async () => "tok" }, { env: "sandbox", realmId: "123" }),
        paymentAccountId: "41",
        paymentType: "CreditCard",
        takeoverDate: "2026-01-01",
        prod: false,
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

/**
 * An expense the drain created in QuickBooks: lines of $7 on account 60 and $3 on 61, a Bill to
 * vendor 77 when `bill`, else a Purchase. The QuickBooks entry sits two days after the receipt.
 */
async function created(day: string, opts: { bill?: boolean; state?: string } = {}) {
  const id = await seedExpense({ state: "qb_complete", receiptTotalCents: 1000, needsReimbursement: !!opts.bill, reimburseePersonId: opts.bill ? 9 : undefined });
  const l1 = await seedLineItem(id, { totalPriceCents: 700 });
  const l2 = await seedLineItem(id, { totalPriceCents: 300 });
  const item = (lineItemId: number, cents: number, account: string) => ({
    lineItemId, description: "Widget", quantity: 1, unitPriceCents: cents, totalPriceCents: cents,
    allocatedTaxCents: 0, allocatedShippingCents: 0, allocatedDiscountCents: 0,
    isDelayed: false, isCapital: false, capitalOwnerId: null, depreciationYears: null, account,
  });
  const payload = {
    schemaVersion: 1, id, vendorName: "TEST-Acme", receiptDate: day, receiptTotalCents: 1000, orgId: ORG,
    needsReimbursement: !!opts.bill, reimbursementFor: null, reimburseePersonId: opts.bill ? 9 : null,
    items: [item(l1, 700, "60"), item(l2, 300, "61")],
  };
  await db.expenseEvent.create({ data: { orgId: ORG, expenseId: id, payload: JSON.stringify(payload) } });
  const qbId = String(nextQbId++);
  const entity = opts.bill ? "Bill" : "Purchase";
  await db.expense.update({
    where: { id },
    data: { receiptDate: day, qbMatchState: opts.state ?? "CREATED", qbTxnId: qbId, qbTxnEntity: entity, qbVendorId: opts.bill ? "77" : null },
  });
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 2);
  const entry: QboBill = {
    Id: qbId,
    TxnDate: d.toISOString().slice(0, 10),
    TotalAmt: 10,
    PrivateNote: `TEST-Acme\n[checkin:${qbKey("expense", id)}]`,
    Line: [line(7, "60"), line(3, "61")],
    ...(opts.bill ? { VendorRef: { value: "77" } } : { AccountRef: { value: "41" } }),
  };
  (opts.bill ? qbo.bills : qbo.purchases).push(entry);
  return { id, entry };
}

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

  it("never checks a hand-booked match", async () => {
    const { id, entry } = await created("2026-09-10", { state: "MATCHED" });
    entry.TotalAmt = 99;

    expect(await checkQbDrift()).toEqual({ checked: 0, drifted: 0, failed: 0 });
    expect(await driftFlag(id)).toBeNull();
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

  it("is skipped while QuickBooks is unbound, and runs in the cron catch-up", async () => {
    const { entry } = await created("2026-09-10");
    entry.TotalAmt = 12;

    expect((await runExpenseCatchUp()).qbDrift).toEqual({ checked: 1, drifted: 1, failed: 0 });
    bindPorts({});
    expect(await checkQbDrift()).toBe("unbound");
  });
});
