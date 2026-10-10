import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { QuickBooksClient, appKeyOf, qbKey, type QboDeposit } from "@inventory/quickbooks";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { configureIncome, type IncomeConfig, type PostCapEvent } from "../../runtime";
import { updateIncomeSettings } from "../../services/settingsService";
import { runReconcile } from "../../lib/reconcile";
import { drainIncomeOutbox, incomeTakeoverLine } from "../../lib/outbox";
import { quickBooksDepositSource } from "../../lib/qb-deposits";
import { reconciliationService } from "../../services/reconciliationService";
import type { MirrorBalanceTxn, MirrorOrderLine, MirrorPayout, OwnerInfo, PayoutMirror } from "../../contract";
import { clearAll, ORG_A } from "../helpers/fixtures";

const NOW = new Date("2026-06-30T12:00:00Z");
const BANK = "35";
const ACCOUNTS = { income: "80", charge_remainder: "81", fees: "90", adjustments: "91" };
const tokens = { current: async () => "tok" };
const realm = { env: "sandbox" as const, realmId: "123" };

interface PostedLine {
  Amount: number;
  DepositLineDetail: { AccountRef: { value: string }; ClassRef?: { value: string } };
}
interface PostedDeposit {
  TxnDate: string;
  DepositToAccountRef: { value: string };
  Line: PostedLine[];
  PrivateNote: string;
}

/** An in-memory QBO company behind the real QuickBooksClient: windowed Deposit reads and Deposit creates. */
class FakeQbo {
  deposits: QboDeposit[] = [];
  posts: { key: string; body: PostedDeposit }[] = [];
  mode: "ok" | "reject" | "accept-then-drop" = "ok";
  /** Keys whose create is refused while every other create succeeds. */
  rejectKeys = new Set<string>();
  private nextId = 1000;

  handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { intuit_tid: "tid" } });
    if ((init?.method ?? "GET") === "GET") {
      const m = /TxnDate >= '(\d{4}-\d{2}-\d{2})' AND TxnDate <= '(\d{4}-\d{2}-\d{2})'/.exec(url.searchParams.get("query") ?? "");
      if (!m) throw new Error(`unexpected query ${url.search}`);
      const list = this.deposits.filter((d) => d.TxnDate >= m[1] && d.TxnDate <= m[2]);
      return json({ QueryResponse: list.length ? { Deposit: list } : {} });
    }
    const body = JSON.parse(String(init?.body)) as PostedDeposit;
    this.posts.push({ key: url.searchParams.get("requestid") ?? "", body });
    if (this.mode === "reject" || this.rejectKeys.has(url.searchParams.get("requestid") ?? "")) return json({ Fault: { Error: [{ code: "6000" }] } }, 400);
    const Id = String(this.nextId++);
    const cents = body.Line.reduce((s, l) => s + Math.round(l.Amount * 100), 0);
    this.deposits.push({ Id, TxnDate: body.TxnDate, TotalAmt: cents / 100, DepositToAccountRef: body.DepositToAccountRef, PrivateNote: body.PrivateNote });
    if (this.mode === "accept-then-drop") throw new Error("socket hang up");
    return json({ Deposit: { Id } });
  };

  hand(Id: string, TxnDate: string, cents: number, account = BANK) {
    this.deposits.push({ Id, TxnDate, TotalAmt: cents / 100, DepositToAccountRef: { value: account } });
  }
}

let qbo: FakeQbo;
let payouts: MirrorPayout[];
let txns: Record<string, MirrorBalanceTxn[]>;
let orderLines: MirrorOrderLine[];
let owners: OwnerInfo[];
let alerts: PostCapEvent[];

const gid = (n: number) => `gid://shopify/ShopifyPaymentsPayout/${n}`;

/** A paid payout of one charge on order `O<n>` with no lines, so the whole charge books at org level. */
function payout(n: number, day: string, netCents: number): string {
  const g = gid(n);
  payouts.push({ payoutGid: g, issuedAt: new Date(`${day}T00:00:00Z`), status: "paid", netCents, currency: "USD", source: "api" });
  txns[g] = [{ txnGid: `${g}/t`, type: "charge", orderGid: `O${n}`, orderName: `#${n}`, amountCents: netCents, feeCents: 0, netCents, source: "api" }];
  return g;
}

function setPayout(g: string, patch: Partial<MirrorPayout>) {
  payouts = payouts.map((p) => (p.payoutGid === g ? { ...p, ...patch } : p));
}

const mirror: PayoutMirror = {
  paidPayoutsSince: async (from) => payouts.filter((p) => p.status === "paid" && p.issuedAt >= from),
  payout: async (g) => payouts.find((p) => p.payoutGid === g) ?? null,
  transactions: async (g) => txns[g] ?? [],
  orderLines: async (gids) => orderLines.filter((l) => gids.includes(l.orderGid)),
  itemsSeen: async () => [],
};

function bind(over: Partial<IncomeConfig> = {}) {
  configureIncome({
    mirror,
    deposits: quickBooksDepositSource(tokens, realm),
    owners: { list: async () => owners },
    bankAccountId: BANK,
    posting: { client: new QuickBooksClient(tokens, realm), accounts: ACCOUNTS, mirrorNewestWins: true },
    alerts: { postCapReached: async (e) => void alerts.push(e) },
    ...over,
  });
}

const rowFor = (g: string) => db.payoutReconciliation.findUniqueOrThrow({ where: { orgId_payoutGid: { orgId: ORG_A, payoutGid: g } } });
const drain = (now = NOW) => drainIncomeOutbox(ORG_A, now);

/** A hand-booked payout matched in QuickBooks, which sets the takeover line at its date. */
function handBooked(n: number, day: string, cents: number) {
  payout(n, day, cents);
  qbo.hand(`H${n}`, day, cents);
}

beforeEach(async () => {
  await clearAll();
  qbo = new FakeQbo();
  vi.stubGlobal("fetch", vi.fn(qbo.handle));
  payouts = [];
  txns = {};
  orderLines = [];
  owners = [];
  alerts = [];
  bind();
});

afterEach(() => {
  configureIncome({});
  vi.unstubAllGlobals();
});

describeDb("drainIncomeOutbox — the takeover line", () => {
  it("with no hand-booked match there is no line, and nothing is created", async () => {
    const p = payout(2, "2026-06-28", 500);
    expect(await drain()).toMatchObject({ post: { posted: 0, waiting: 1 } });
    expect(qbo.posts).toHaveLength(0);
    expect(await rowFor(p)).toMatchObject({ status: "WAITING", depositId: null });
  });

  it("creates the deposit for a payout after the line, keyed and dated inside its window", async () => {
    handBooked(1, "2026-06-01", 970);
    const p = payout(2, "2026-06-28", 500);

    expect(await drain()).toMatchObject({ reconcile: { matched: 1 }, post: { posted: 1 } });
    expect(await rowFor(gid(1))).toMatchObject({ status: "MATCHED", origin: "matched", depositId: "H1" });
    expect(qbo.posts).toHaveLength(1);
    const { key, body } = qbo.posts[0];
    expect(key).toBe(qbKey("income", p));
    expect(appKeyOf(body)).toBe(key);
    expect(body).toMatchObject({ TxnDate: "2026-06-28", DepositToAccountRef: { value: BANK } });
    const row = await rowFor(p);
    expect(row).toMatchObject({
      status: "POSTED", origin: "created", kind: null, depositTxnDate: "2026-06-28", depositTotalCents: 500,
    });
    expect(row.depositId).toBe(qbo.deposits.at(-1)?.Id);
    expect(await db.incomeAuditLog.count({ where: { action: "reconciliation.posted" } })).toBe(1);
  });

  it("never creates for a payout on or before the line; it waits, then opens NO_DEPOSIT", async () => {
    handBooked(1, "2026-06-27", 970);
    const p = payout(2, "2026-06-25", 500);

    expect(await drain()).toMatchObject({ post: { posted: 0, waiting: 1 } });
    expect(await rowFor(p)).toMatchObject({ status: "WAITING" });

    await drain(new Date("2026-07-03T12:00:00Z"));
    expect(qbo.posts).toHaveLength(0);
    expect(await rowFor(p)).toMatchObject({ status: "OPEN", kind: "NO_DEPOSIT" });
  });

  it("an app-created deposit never moves the line; a hand-booked one does", async () => {
    handBooked(1, "2026-06-01", 970);
    payout(2, "2026-06-26", 500);
    await drain();
    expect((await rowFor(gid(2))).status).toBe("POSTED");

    // Between the hand line (06-01) and the app's own deposit (06-26): still after the line.
    payout(3, "2026-06-24", 300);
    await drain();
    expect(await rowFor(gid(3))).toMatchObject({ status: "POSTED", origin: "created" });

    // A newer hand booking moves the line to 06-29, so 06-28 is now too old.
    handBooked(4, "2026-06-29", 444);
    payout(5, "2026-06-28", 200);
    await drain();
    expect(await rowFor(gid(4))).toMatchObject({ status: "MATCHED", origin: "matched" });
    expect(await rowFor(gid(5))).toMatchObject({ status: "WAITING" });
    expect(qbo.posts).toHaveLength(2);
  });
});

describeDb("drainIncomeOutbox — the line never steps back", () => {
  it("a drifted hand match keeps its line, so no older payout becomes create-eligible", async () => {
    handBooked(1, "2026-06-01", 970);
    handBooked(4, "2026-06-29", 444);
    await drain();
    expect(await rowFor(gid(4))).toMatchObject({ status: "MATCHED", origin: "matched" });
    expect(await incomeTakeoverLine(ORG_A)).toBe("2026-06-29");

    qbo.deposits = qbo.deposits.filter((d) => d.Id !== "H4");
    payout(5, "2026-06-28", 200);
    await drain();
    expect(await rowFor(gid(4))).toMatchObject({ status: "OPEN", kind: "DRIFT", origin: null });
    expect(await incomeTakeoverLine(ORG_A)).toBe("2026-06-29");
    expect(await rowFor(gid(5))).toMatchObject({ status: "WAITING" });
    expect(qbo.posts).toHaveLength(0);
  });

  it("a finance manual match of a hand deposit sets the line", async () => {
    handBooked(1, "2026-06-01", 970);
    await drain();
    const p = payout(2, "2026-06-28", 500);
    qbo.mode = "reject";
    await drain();
    qbo.mode = "ok";
    qbo.hand("H2", "2026-06-29", 499);
    await reconciliationService.matchToDeposit(ORG_A, (await rowFor(p)).id, "H2", { userId: 9 });
    expect(await incomeTakeoverLine(ORG_A)).toBe("2026-06-28");
  });
});

describeDb("drainIncomeOutbox — every findOrCreate outcome", () => {
  beforeEach(() => handBooked(1, "2026-06-01", 970));

  it("found by amount (finance retry): a hand entry booked after a failed create links, nothing more is posted", async () => {
    const p = payout(2, "2026-06-28", 500);
    qbo.mode = "reject";
    await drain();
    qbo.mode = "ok";
    qbo.hand("H2", "2026-06-29", 500);

    const row = await rowFor(p);
    expect(await reconciliationService.resolve(ORG_A, row.id, { action: "retry" }, { userId: 9 })).toMatchObject({
      status: "MATCHED", origin: "matched", depositId: "H2",
    });
    expect(qbo.posts).toHaveLength(1);
  });

  it("found by key (finance retry): a create QuickBooks accepted is recorded as the app's own", async () => {
    const p = payout(2, "2026-06-28", 500);
    qbo.mode = "accept-then-drop";
    await drain();
    qbo.mode = "ok";

    const row = await rowFor(p);
    expect(await reconciliationService.resolve(ORG_A, row.id, { action: "retry" }, { userId: 9 })).toMatchObject({
      status: "POSTED", origin: "created", depositId: qbo.deposits.at(-1)?.Id,
    });
    expect(qbo.posts).toHaveLength(1);
  });

  it("a hand entry of the same amount and date into another account is not a match", async () => {
    const p = payout(2, "2026-06-28", 500);
    qbo.hand("OTHER", "2026-06-28", 500, "36");

    expect(await runReconcile(ORG_A, NOW)).toMatchObject({ matched: 1 });
    expect(await rowFor(p)).toMatchObject({ status: "WAITING", depositId: null });
    await drain();
    expect(await rowFor(p)).toMatchObject({ status: "POSTED", origin: "created" });
    expect((await rowFor(p)).depositId).not.toBe("OTHER");
  });

  it("ambiguous: two fitting hand entries go to finance's queue, nothing is posted", async () => {
    const p = payout(2, "2026-06-28", 500);
    qbo.hand("A", "2026-06-28", 500);
    qbo.hand("B", "2026-06-29", 500);
    await drain();
    expect(await rowFor(p)).toMatchObject({ status: "OPEN", kind: "AMBIGUOUS_DEPOSIT", depositId: null });
    expect(qbo.posts).toHaveLength(0);
  });

  it("failed: a refused create opens POST_FAILED; later runs leave it, finance's retry posts it with the same key", async () => {
    const p = payout(2, "2026-06-28", 500);
    qbo.mode = "reject";
    expect(await drain()).toMatchObject({ post: { failed: 1 } });
    expect(await rowFor(p)).toMatchObject({ status: "OPEN", kind: "POST_FAILED", depositId: null });
    const failed = await db.incomeAuditLog.findFirstOrThrow({ where: { action: "reconciliation.post_failed" } });
    expect(failed.reason).toContain("400");

    qbo.mode = "ok";
    await drain();
    expect(await rowFor(p)).toMatchObject({ status: "OPEN", kind: "POST_FAILED" });
    expect(qbo.posts).toHaveLength(1);

    await reconciliationService.resolve(ORG_A, (await rowFor(p)).id, { action: "retry" }, { userId: 9 });
    expect(await rowFor(p)).toMatchObject({ status: "POSTED", origin: "created", kind: null });
    expect(qbo.posts.map((x) => x.key)).toEqual([qbKey("income", p), qbKey("income", p)]);
  });

  it("is idempotent on the payout: repeated runs post once", async () => {
    payout(2, "2026-06-28", 500);
    await drain();
    await drain();
    await drain();
    expect(qbo.posts).toHaveLength(1);
  });

  it("caps the number of creates per run and alerts finance when the cap stops it", async () => {
    for (let n = 10; n < 40; n++) payout(n, "2026-06-28", 100 + n);
    expect(await drain()).toMatchObject({ post: { posted: 25, capped: "count" } });
    expect(alerts).toEqual([expect.objectContaining({ orgId: ORG_A, cap: "count", created: 25, remaining: 5 })]);
    expect(await drain()).toMatchObject({ post: { posted: 5, capped: null } });
    expect(alerts).toHaveLength(1);
  });

  it("caps the cents created per run at the org setting", async () => {
    await updateIncomeSettings(ORG_A, { maxCreateCentsPerRun: 1000 }, { userId: 9, isFinance: true, isBoard: false });
    payout(2, "2026-06-27", 500);
    payout(3, "2026-06-28", 400);
    payout(4, "2026-06-29", 300);
    expect(await drain()).toMatchObject({ post: { posted: 2, capped: "cents" } });
    expect(alerts).toEqual([expect.objectContaining({ cap: "cents", created: 2, createdCents: 900, remaining: 1 })]);
    expect(await rowFor(gid(4))).toMatchObject({ status: "WAITING" });
  });

  it("parks a single payout over the cents cap for finance and alerts, without stalling the rest", async () => {
    await updateIncomeSettings(ORG_A, { maxCreateCentsPerRun: 1000 }, { userId: 9, isFinance: true, isBoard: false });
    const big = payout(2, "2026-06-27", 5000);
    const small = payout(3, "2026-06-28", 400);
    expect(await drain()).toMatchObject({ post: { posted: 1, over_cap: 1 } });
    expect(await rowFor(big)).toMatchObject({ status: "OPEN", kind: "OVER_CAP", depositId: null });
    expect(await rowFor(small)).toMatchObject({ status: "POSTED" });
    expect(alerts).toEqual([expect.objectContaining({ cap: "cents" })]);

    await drain();
    expect(qbo.posts).toHaveLength(1);
    await reconciliationService.resolve(ORG_A, (await rowFor(big)).id, { action: "retry" }, { userId: 9 });
    expect(await rowFor(big)).toMatchObject({ status: "POSTED", origin: "created" });
  });

  it("failures do not use up the cap", async () => {
    await updateIncomeSettings(ORG_A, { maxCreatesPerRun: 2 }, { userId: 9, isFinance: true, isBoard: false });
    qbo.mode = "reject";
    for (let n = 10; n < 15; n++) payout(n, "2026-06-28", 100 + n);
    expect(await drain()).toMatchObject({ post: { failed: 5, capped: null } });
    expect(alerts).toHaveLength(0);
  });

  it("never posts a WAITING payout older than its match window", async () => {
    const p = payout(2, "2026-06-10", 500);
    await db.payoutReconciliation.create({
      data: { orgId: ORG_A, payoutGid: p, payoutDate: "2026-06-10", payoutNetCents: 500, status: "WAITING" },
    });
    bind({ reconcileFrom: new Date("2026-06-20T00:00:00Z") });
    await drain();
    expect(await rowFor(p)).toMatchObject({ status: "WAITING" });
    expect(qbo.posts).toHaveLength(0);
  });

  it("a deposit dated a day before the payout is found, not created again", async () => {
    const p = payout(2, "2026-06-28", 500);
    qbo.hand("EARLY", "2026-06-27", 500);
    await drain();
    expect(await rowFor(p)).toMatchObject({ status: "MATCHED", origin: "matched", depositId: "EARLY" });
    expect(qbo.posts).toHaveLength(0);
  });

  it("a deposit dated more than the grace before the payout is not its match", async () => {
    const p = payout(2, "2026-06-28", 500);
    qbo.hand("TOO_EARLY", "2026-06-25", 500);
    await drain();
    expect(await rowFor(p)).toMatchObject({ status: "POSTED", origin: "created" });
  });
});

describeDb("drainIncomeOutbox — replay after a crash", () => {
  beforeEach(() => handBooked(1, "2026-06-01", 970));

  it("QuickBooks accepted but the answer was lost: the next run finds it by key and posts nothing", async () => {
    const p = payout(2, "2026-06-28", 500);
    qbo.mode = "accept-then-drop";
    await drain();
    expect(await rowFor(p)).toMatchObject({ status: "OPEN", kind: "POST_FAILED" });

    qbo.mode = "ok";
    await drain();
    expect(await rowFor(p)).toMatchObject({ status: "POSTED", origin: "created", depositId: qbo.deposits.at(-1)?.Id });
    expect(qbo.posts).toHaveLength(1);
  });

  it("the outcome was never recorded: a row still WAITING is found by key, never booked twice", async () => {
    const p = payout(2, "2026-06-28", 500);
    await drain();
    const created = (await rowFor(p)).depositId;
    await db.payoutReconciliation.update({
      where: { orgId_payoutGid: { orgId: ORG_A, payoutGid: p } },
      data: { status: "WAITING", origin: null, depositId: null, depositTxnDate: null, depositTotalCents: null },
    });

    await drain();
    expect(await rowFor(p)).toMatchObject({ status: "POSTED", origin: "created", depositId: created });
    expect(qbo.posts).toHaveLength(1);
  });

  it("the app's own deposit is never hand-matched to another payout of the same amount", async () => {
    const p2 = payout(2, "2026-06-28", 500);
    await drain();
    await db.payoutReconciliation.delete({ where: { orgId_payoutGid: { orgId: ORG_A, payoutGid: p2 } } });
    setPayout(p2, { status: "in_transit" });
    const p3 = payout(3, "2026-06-28", 500);

    await drain();
    // Created here today; parked as ambiguous for finance once the key-marker fix (#1975) lands.
    const row = await rowFor(p3);
    expect(row.depositId).not.toBe(qbo.deposits.find((d) => appKeyOf(d) === qbKey("income", p2))?.Id);
    expect(row.origin).not.toBe("matched");
    expect(await db.incomeAuditLog.count({ where: { action: "reconciliation.matched" } })).toBe(1);
  });
});

describeDb("drainIncomeOutbox — deposit lines", () => {
  beforeEach(() => handBooked(1, "2026-06-01", 970));

  function orderPayout(n: number) {
    const g = payout(n, "2026-06-28", 0);
    // Charge 10000 over two lines (6000 mapped, 4000 unmapped), fee 320; a 150 adjustment.
    txns[g] = [
      { txnGid: `${g}/c`, type: "charge", orderGid: "O9", orderName: "#9", amountCents: 10000, feeCents: 320, netCents: 9680, source: "api" },
      { txnGid: `${g}/a`, type: "adjustment", orderGid: null, orderName: null, amountCents: 150, feeCents: 0, netCents: 150, source: "api" },
    ];
    setPayout(g, { netCents: 9830 });
    orderLines = [
      { orderGid: "O9", variantId: "V1", title: "Camp", sku: null, quantity: 2, priceCents: 3000, discountCents: 0 },
      { orderGid: "O9", variantId: "V2", title: "Shirt", sku: null, quantity: 1, priceCents: 4000, discountCents: 0 },
    ];
    return g;
  }

  it("splits each charge by order line to its bucket's Class; unmapped, fees and adjustments book at org level; sums to net", async () => {
    const g = orderPayout(2);
    owners = [{ id: 7, name: "Camp", archivedAt: null, quickBooksClassId: "700" }];
    await db.incomeItemCategory.create({ data: { orgId: ORG_A, variantId: "V1", budgetOwnerId: 7 } });

    await drain();
    expect(await rowFor(g)).toMatchObject({ status: "POSTED", depositTotalCents: 9830 });
    const lines = qbo.posts[0].body.Line.map((l) => ({
      cents: Math.round(l.Amount * 100),
      account: l.DepositLineDetail.AccountRef.value,
      cls: l.DepositLineDetail.ClassRef?.value,
    }));
    expect(lines).toEqual(
      expect.arrayContaining([
        { cents: 6000, account: "80", cls: "700" },
        { cents: 4000, account: "80", cls: undefined },
        { cents: -320, account: "90", cls: undefined },
        { cents: 150, account: "91", cls: undefined },
      ]),
    );
    expect(lines).toHaveLength(4);
    expect(lines.reduce((s, l) => s + l.cents, 0)).toBe(9830);
  });

  it.each([
    ["archived", { id: 7, name: "Camp", archivedAt: new Date("2026-01-01"), quickBooksClassId: "700" }],
    ["without a Class", { id: 7, name: "Camp", archivedAt: null, quickBooksClassId: null }],
    ["missing from the directory", null],
  ])("a mapping to a bucket %s fails closed to POST_FAILED", async (_label, owner) => {
    const g = orderPayout(2);
    owners = owner ? [owner] : [];
    await db.incomeItemCategory.create({ data: { orgId: ORG_A, variantId: "V1", budgetOwnerId: 7 } });

    await drain();
    expect(await rowFor(g)).toMatchObject({ status: "OPEN", kind: "POST_FAILED" });
    expect(qbo.posts).toHaveLength(0);
  });
});

describeDb("drainIncomeOutbox — mirror reverts and binding", () => {
  beforeEach(() => handBooked(1, "2026-06-01", 970));

  it("a payout status revert raises DRIFT on a POSTED row, which is never rebooked", async () => {
    const p = payout(2, "2026-06-28", 500);
    await drain();
    expect((await rowFor(p)).status).toBe("POSTED");

    setPayout(p, { status: "in_transit" });
    await drain();
    expect(await rowFor(p)).toMatchObject({ status: "OPEN", kind: "DRIFT", depositId: null });

    setPayout(p, { status: "paid" });
    await drain();
    await drain();
    expect(await rowFor(p)).toMatchObject({ status: "OPEN", kind: "DRIFT" });
    expect(qbo.posts).toHaveLength(1);
  });

  it("a WAITING payout that leaves paid is not posted", async () => {
    const p = payout(2, "2026-06-28", 500);
    configureIncome({ mirror, deposits: quickBooksDepositSource(tokens, realm), bankAccountId: BANK });
    await runReconcile(ORG_A, NOW);
    expect((await rowFor(p)).status).toBe("WAITING");

    setPayout(p, { status: "in_transit" });
    bind();
    expect(await drain()).toMatchObject({ post: { posted: 0 } });
    expect(qbo.posts).toHaveLength(0);
  });

  it("creates nothing until the mirror is declared newest-wins", async () => {
    bind({ posting: { client: new QuickBooksClient(tokens, realm), accounts: ACCOUNTS, mirrorNewestWins: false } });
    const p = payout(2, "2026-06-28", 500);
    expect(await drain()).toMatchObject({ reconcile: { status: "ran" }, post: "gated" });
    expect(await rowFor(p)).toMatchObject({ status: "WAITING" });
    expect(qbo.posts).toHaveLength(0);
  });

  it("never creates a deposit from a hand-loaded mirror payout", async () => {
    const p = payout(2, "2026-06-28", 500);
    setPayout(p, { source: "hand_loaded" });
    expect(await drain()).toMatchObject({ post: { posted: 0, waiting: 1 } });
    expect(qbo.posts).toHaveLength(0);
  });

  it("without a posting binding the run only matches; payouts wait", async () => {
    bind({ posting: undefined });
    const p = payout(2, "2026-06-28", 500);
    expect(await drain()).toMatchObject({ reconcile: { status: "ran", matched: 1 }, post: "unbound" });
    expect(await rowFor(p)).toMatchObject({ status: "WAITING" });
    expect(qbo.posts).toHaveLength(0);
  });

  it("finance's retry posts a POST_FAILED payout", async () => {
    const p = payout(2, "2026-06-28", 500);
    qbo.mode = "reject";
    await drain();
    const row = await rowFor(p);
    qbo.mode = "ok";

    expect(await reconciliationService.resolve(ORG_A, row.id, { action: "retry" }, { userId: 9, username: "fin" })).toMatchObject({
      status: "POSTED", origin: "created",
    });
    expect(qbo.posts).toHaveLength(2);
    expect(await db.incomeAuditLog.findFirstOrThrow({ where: { action: "reconciliation.posted" } })).toMatchObject({
      actorUserId: 9, actorUsername: "fin",
    });
  });

  it("one payout failing mid-batch leaves the others posted", async () => {
    payout(2, "2026-06-26", 500);
    const bad = payout(3, "2026-06-27", 400);
    payout(4, "2026-06-28", 300);
    qbo.rejectKeys.add(qbKey("income", bad));

    expect(await drain()).toMatchObject({ post: { posted: 2, failed: 1, capped: null } });
    expect(await rowFor(gid(2))).toMatchObject({ status: "POSTED" });
    expect(await rowFor(bad)).toMatchObject({ status: "OPEN", kind: "POST_FAILED" });
    expect(await rowFor(gid(4))).toMatchObject({ status: "POSTED" });
  });

  it("a payout on or before the line never counts against the caps", async () => {
    handBooked(5, "2026-06-27", 444);
    await updateIncomeSettings(ORG_A, { maxCreateCentsPerRun: 1000 }, { userId: 9, isFinance: true, isBoard: false });
    const old = payout(2, "2026-06-26", 5000);
    const fresh = payout(3, "2026-06-28", 400);

    expect(await drain()).toMatchObject({ post: { posted: 1, over_cap: 0, capped: null } });
    expect(await rowFor(old)).toMatchObject({ status: "WAITING" });
    expect(await rowFor(fresh)).toMatchObject({ status: "POSTED" });
    expect(alerts).toHaveLength(0);
  });
});

describeDb("income settings", () => {
  const finance = { userId: 9, username: "fin", isFinance: true, isBoard: false };
  const board = { userId: 8, isFinance: false, isBoard: true };

  it("defaults to 25 creates and $25,000 per run", async () => {
    await expect(updateIncomeSettings(ORG_A, {}, finance)).resolves.toEqual({ maxCreatesPerRun: 25, maxCreateCentsPerRun: 2_500_000 });
  });

  it("finance may lower a cap; raising one takes the board; each change is audited", async () => {
    await updateIncomeSettings(ORG_A, { maxCreatesPerRun: 10 }, finance);
    await expect(updateIncomeSettings(ORG_A, { maxCreatesPerRun: 20 }, finance)).rejects.toMatchObject({ statusCode: 403 });
    await expect(updateIncomeSettings(ORG_A, { maxCreatesPerRun: 20 }, board)).resolves.toMatchObject({ maxCreatesPerRun: 20 });
    await expect(updateIncomeSettings(ORG_A, { maxCreatesPerRun: 1 }, { userId: 7, isFinance: false, isBoard: false })).rejects.toMatchObject({ statusCode: 403 });

    const changes = await db.incomeAuditLog.findMany({ where: { action: "settings.updated" }, orderBy: { id: "asc" } });
    expect(changes.map((c) => [c.actorUserId, c.before, c.after])).toEqual([
      [9, JSON.stringify({ maxCreatesPerRun: 25 }), JSON.stringify({ maxCreatesPerRun: 10 })],
      [8, JSON.stringify({ maxCreatesPerRun: 10 }), JSON.stringify({ maxCreatesPerRun: 20 })],
    ]);
  });
});
