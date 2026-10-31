import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { QuickBooksClient, appKeyOf, qbKey, type QboDeposit } from "@checkin/quickbooks";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { configureIncome, incomeRuntime, type BucketUnusableEvent, type IncomeConfig, type PostCapEvent } from "../../runtime";
import { updateIncomeSettings } from "../../services/settingsService";
import { ATTEMPTED_MATCH_NOTE, lockReconciliation, runReconcile } from "../../lib/reconcile";
import { CLOSED_NOTE, drainIncomeOutbox, missingRoles, runIncomeOrphanSweep } from "../../lib/outbox";
import { quickBooksDepositSource } from "../../lib/qb-deposits";
import { reconciliationService } from "../../services/reconciliationService";
import { itemCategoryService } from "../../services/itemCategoryService";
import type { MirrorBalanceTxn, MirrorOrderLine, MirrorOrderSubtotal, MirrorPayout, OwnerInfo, PayoutMirror } from "../../contract";
import { clearAll, ORG_A } from "../helpers/fixtures";
import { depositStatus, expectDeposit, type ExpectedDeposit } from "../../lib/intake";
import type { BooksMap, BooksMapRole } from "@checkin/quickbooks";

const NOW = new Date("2026-06-30T12:00:00Z");
/** When the shared setup switches income posting on: before any payout the tests add. */
const ON_AT = new Date("2026-06-30T11:00:00Z");
const BANK = "35";
const SHOPIFY_ROLES: Partial<Record<BooksMapRole, string>> = { SHOPIFY_BANK: BANK, SHOPIFY_SALES: "80", SHOPIFY_CHARGE_REMAINDER: "81", SHOPIFY_FEES: "90", SHOPIFY_ADJUSTMENTS: "91" };
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
  mode: "ok" | "reject" | "accept-then-drop" | "closed" = "ok";
  /** The books closing date Preferences reports. */
  closeDate: string | null = "2026-05-31";
  /** Preferences reads fail. */
  closeDateFails = false;
  /** When QuickBooks created each deposit, by Id. */
  createdAt = new Map<string, number>();
  /** Runs inside a create, before QuickBooks applies it. */
  onCreate: (() => Promise<void>) | null = null;
  /** Runs on each dated deposit read, before QuickBooks answers. */
  onWindowRead: (() => Promise<void>) | null = null;
  /** Keys whose create is refused while every other create succeeds. */
  rejectKeys = new Set<string>();
  private nextId = 1000;

  handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { intuit_tid: "tid" } });
    if ((init?.method ?? "GET") === "GET") {
      if (url.searchParams.get("query") === "SELECT * FROM Preferences") {
        if (this.closeDateFails) return json({ Fault: { Error: [{ code: "3100" }] } }, 400);
        return json({ QueryResponse: { Preferences: [{ AccountingInfoPrefs: this.closeDate ? { BookCloseDate: this.closeDate } : {} }] } });
      }
      const since = /MetaData\.CreateTime >= '([^']+)' ORDERBY MetaData\.CreateTime STARTPOSITION (\d+) MAXRESULTS (\d+)/.exec(url.searchParams.get("query") ?? "");
      if (since) {
        const list = this.deposits.filter((d) => (this.createdAt.get(d.Id) ?? 0) >= Date.parse(since[1])).slice(Number(since[2]) - 1, Number(since[2]) - 1 + Number(since[3]));
        return json({ QueryResponse: list.length ? { Deposit: list } : {} });
      }
      const m = /TxnDate >= '(\d{4}-\d{2}-\d{2})' AND TxnDate <= '(\d{4}-\d{2}-\d{2})'/.exec(url.searchParams.get("query") ?? "");
      if (!m) throw new Error(`unexpected query ${url.search}`);
      await this.onWindowRead?.();
      const list = this.deposits.filter((d) => d.TxnDate >= m[1] && d.TxnDate <= m[2]);
      return json({ QueryResponse: list.length ? { Deposit: list } : {} });
    }
    const body = JSON.parse(String(init?.body)) as PostedDeposit;
    this.posts.push({ key: url.searchParams.get("requestid") ?? "", body });
    if (this.mode === "closed") return json({ Fault: { Error: [{ code: "6210" }] } }, 400);
    if (this.mode === "reject" || this.rejectKeys.has(url.searchParams.get("requestid") ?? "")) return json({ Fault: { Error: [{ code: "6000" }] } }, 400);
    await this.onCreate?.();
    const Id = String(this.nextId++);
    const cents = body.Line.reduce((s, l) => s + Math.round(l.Amount * 100), 0);
    this.deposits.push({ Id, TxnDate: body.TxnDate, TotalAmt: cents / 100, DepositToAccountRef: body.DepositToAccountRef, PrivateNote: body.PrivateNote });
    this.createdAt.set(Id, Date.now());
    if (this.mode === "accept-then-drop") throw new Error("socket hang up");
    return json({ Deposit: { Id } });
  };

  hand(Id: string, TxnDate: string, cents: number, account = BANK) {
    this.deposits.push({ Id, TxnDate, TotalAmt: cents / 100, DepositToAccountRef: { value: account } });
    this.createdAt.set(Id, Date.now());
  }
}

let qbo: FakeQbo;
let payouts: MirrorPayout[];
let txns: Record<string, MirrorBalanceTxn[]>;
let orderLines: MirrorOrderLine[];
let subtotals: MirrorOrderSubtotal[];
let owners: OwnerInfo[];
let alerts: PostCapEvent[];
let sweepAlerts: { orgId: string; since: Date }[];
let bucketAlerts: BucketUnusableEvent[];
let activeClasses: string[];

const gid = (n: number) => `gid://shopify/ShopifyPaymentsPayout/${n}`;

/** A paid payout of one charge on order `O<n>` with one custom-item line, so the whole charge books at org level. */
function payout(n: number, day: string, netCents: number): string {
  const g = gid(n);
  payouts.push({ payoutGid: g, issuedAt: new Date(`${day}T00:00:00Z`), status: "paid", netCents, currency: "USD", source: "api" });
  txns[g] = [{ txnGid: `${g}/t`, type: "charge", orderGid: `O${n}`, orderName: `#${n}`, amountCents: netCents, feeCents: 0, netCents, source: "api" }];
  orderLines.push({ orderGid: `O${n}`, variantId: null, title: "Custom", sku: null, quantity: 1, currentQuantity: 1, priceCents: netCents, discountCents: 0 });
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
  orderSubtotals: async (gids) => subtotals.filter((o) => gids.includes(o.orderGid)),
  itemsSeen: async () => [],
};

/** Shopify's roles, with each bucket's Class read from the owner directory. */
const shopifyMap: BooksMap = {
  accounts: async () => SHOPIFY_ROLES,
  classes: async () => new Map(owners.flatMap((o) => (o.quickBooksClassId ? [[o.id, o.quickBooksClassId] as const] : []))),
};

function bind(over: Partial<IncomeConfig> = {}) {
  configureIncome({
    mirror,
    deposits: quickBooksDepositSource(tokens, realm),
    owners: { list: async () => owners },
    booksMap: shopifyMap,
    posting: { client: new QuickBooksClient(tokens, realm), mirrorNewestWins: true },
    classes: { activeClassIds: async () => activeClasses },
    alerts: {
      postCapReached: async (e) => void alerts.push(e),
      bucketUnusable: async (e) => void bucketAlerts.push(e),
      sweepIncomplete: async (e) => void sweepAlerts.push(e),
    },
    ...over,
  });
}

const rowFor = (g: string) => db.payoutReconciliation.findUniqueOrThrow({ where: { orgId_payoutGid: { orgId: ORG_A, payoutGid: g } } });
const drain = (now = NOW) => drainIncomeOutbox(ORG_A, now);
const finance = { userId: 9 };
const resolve = (g: string, req: Parameters<typeof reconciliationService.resolve>[2]) =>
  rowFor(g).then((r) => reconciliationService.resolve(ORG_A, r.id, req, finance));

/** The first connected drain, before any payout: switches income posting on at ON_AT. */
const switchOn = () => drain(ON_AT);

beforeEach(async () => {
  await clearAll();
  qbo = new FakeQbo();
  vi.stubGlobal("fetch", vi.fn(qbo.handle));
  payouts = [];
  txns = {};
  orderLines = [];
  subtotals = [];
  owners = [];
  alerts = [];
  sweepAlerts = [];
  bucketAlerts = [];
  activeClasses = ["700"];
  bind();
});

afterEach(() => {
  configureIncome({});
  vi.unstubAllGlobals();
});

describeDb("drainIncomeOutbox — switch-on and the open period", () => {
  it("the first connected drain reconciles, then switches on; a payout it already held goes to finance at once", async () => {
    const p = payout(2, "2026-06-28", 500);
    expect(await drain()).toMatchObject({ post: { posted: 0, queued: 1 } });
    expect(await rowFor(p)).toMatchObject({ status: "OPEN", kind: "NO_DEPOSIT", depositId: null, qbNote: null });
    expect(qbo.posts).toHaveLength(0);
    const { qbPostingOnAt } = await db.incomeOrgSettings.findUniqueOrThrow({ where: { orgId: ORG_A } });
    expect(qbPostingOnAt).toEqual(NOW);

    await drain(new Date("2026-07-01T12:00:00Z"));
    expect((await db.incomeOrgSettings.findUniqueOrThrow({ where: { orgId: ORG_A } })).qbPostingOnAt).toEqual(NOW);
  });

  it("an open-period payout finance has booked by hand is matched, never sent to finance", async () => {
    payout(2, "2026-06-28", 500);
    qbo.hand("H2", "2026-06-28", 500);
    expect(await drain()).toMatchObject({ reconcile: { matched: 1 }, post: { queued: 0 } });
    expect(await rowFor(gid(2))).toMatchObject({ status: "MATCHED", origin: "matched", depositId: "H2" });
  });

  it("a payout first seen after switch-on is created, keyed and dated inside its window", async () => {
    await switchOn();
    const p = payout(2, "2026-06-28", 500);

    expect(await drain()).toMatchObject({ post: { posted: 1 } });
    expect(qbo.posts).toHaveLength(1);
    const { key, body } = qbo.posts[0];
    expect(key).toBe(qbKey("income", p));
    expect(appKeyOf(body)).toBe(key);
    expect(body).toMatchObject({ TxnDate: "2026-06-28", DepositToAccountRef: { value: BANK } });
    const row = await rowFor(p);
    expect(row).toMatchObject({
      status: "POSTED", origin: "created", kind: null, depositTxnDate: "2026-06-28", depositTotalCents: 500, postClaimedAt: null,
    });
    expect(row.qbCreateAttemptedAt).not.toBeNull();
    expect(row.depositId).toBe(qbo.deposits.at(-1)?.Id);
    expect(await db.incomeAuditLog.count({ where: { action: "reconciliation.posted" } })).toBe(1);
  });

  it("a payout the mirror delivers weeks late is created, not timed out to finance", async () => {
    await switchOn();
    const p = payout(2, "2026-06-10", 500);
    expect(await drain()).toMatchObject({ post: { posted: 1 } });
    expect(await rowFor(p)).toMatchObject({ status: "POSTED", depositTxnDate: "2026-06-10" });
  });

  it("an open-period payout is never marked attempted, so a later hand booking matches on its own", async () => {
    const p = payout(2, "2026-06-28", 500);
    await drain();
    expect(await rowFor(p)).toMatchObject({ kind: "NO_DEPOSIT", qbCreateAttemptedAt: null });
    qbo.hand("H2", "2026-06-28", 500);
    await drain();
    expect(await rowFor(p)).toMatchObject({ status: "MATCHED", depositId: "H2" });
  });

  it("finance books an open-period payout; it still matches first and is never capped", async () => {
    await updateIncomeSettings(ORG_A, { maxCreateCentsPerRun: 100 }, { userId: 9, isFinance: true, isBoard: false });
    const p = payout(2, "2026-06-28", 500);
    await drain();
    expect(await resolve(p, { action: "book" })).toMatchObject({ status: "POSTED", origin: "created" });
    expect(qbo.posts).toHaveLength(1);
    expect(alerts).toHaveLength(0);
  });

  it("a pre-switch-on payout never counts against the caps", async () => {
    await updateIncomeSettings(ORG_A, { maxCreateCentsPerRun: 1000 }, { userId: 9, isFinance: true, isBoard: false });
    const old = payout(2, "2026-06-26", 5000);
    await drain(ON_AT);
    const fresh = payout(3, "2026-06-28", 400);

    expect(await drain()).toMatchObject({ post: { posted: 1, over_cap: 0, capped: null } });
    expect(await rowFor(old)).toMatchObject({ status: "OPEN", kind: "NO_DEPOSIT" });
    expect(await rowFor(fresh)).toMatchObject({ status: "POSTED" });
    expect(alerts).toHaveLength(0);
  });

  it("book is offered only on NO_DEPOSIT", async () => {
    await switchOn();
    const p = payout(2, "2026-06-28", 500);
    qbo.mode = "reject";
    await drain();
    await expect(resolve(p, { action: "book" })).rejects.toMatchObject({ status: 409 });
  });
});

describeDb("drainIncomeOutbox — closed books", () => {
  it("with no closing date, nothing dated before switch-on is created; it goes to finance as closed", async () => {
    qbo.closeDate = null;
    await switchOn();
    const before = payout(2, "2026-06-29", 500);
    const onDay = payout(3, "2026-06-30", 400);

    expect(await drain()).toMatchObject({ post: { posted: 1, queued: 1 } });
    expect(await rowFor(before)).toMatchObject({ status: "OPEN", kind: "NO_DEPOSIT", qbNote: CLOSED_NOTE });
    expect(await rowFor(onDay)).toMatchObject({ status: "POSTED" });
  });

  it("a payout the closing date covers is never created, even by finance's book", async () => {
    qbo.closeDate = "2026-06-28";
    await switchOn();
    const p = payout(2, "2026-06-28", 500);

    await drain();
    expect(await rowFor(p)).toMatchObject({ status: "OPEN", kind: "NO_DEPOSIT", qbNote: CLOSED_NOTE });
    expect(await resolve(p, { action: "book" })).toMatchObject({ status: "OPEN", kind: "NO_DEPOSIT", qbNote: CLOSED_NOTE });
    expect(qbo.posts).toHaveLength(0);
  });

  it("a hand booking reconcile matches answers the closed note and leaves the queue", async () => {
    qbo.closeDate = "2026-06-28";
    await switchOn();
    const p = payout(2, "2026-06-28", 500);
    await drain();
    expect(await rowFor(p)).toMatchObject({ kind: "NO_DEPOSIT", qbNote: CLOSED_NOTE, qbCreateAttemptedAt: null });

    qbo.hand("H2", "2026-06-28", 500);
    await drain();
    expect(await rowFor(p)).toMatchObject({ status: "MATCHED", depositId: "H2", qbNote: null, reason: null });
    expect(await reconciliationService.countQueue(ORG_A)).toBe(0);
  });

  it("a match in closed books is still allowed", async () => {
    qbo.closeDate = "2026-06-29";
    await switchOn();
    payout(2, "2026-06-28", 500);
    qbo.hand("H2", "2026-06-28", 500);
    await drain();
    expect(await rowFor(gid(2))).toMatchObject({ status: "MATCHED", depositId: "H2" });
  });

  it("a create QuickBooks refuses as a closed period goes to finance as closed, never POST_FAILED", async () => {
    await switchOn();
    const p = payout(2, "2026-06-28", 500);
    qbo.mode = "closed";

    expect(await drain()).toMatchObject({ post: { posted: 0, failed: 0, queued: 1 } });
    expect(await rowFor(p)).toMatchObject({ status: "OPEN", kind: "NO_DEPOSIT", qbNote: CLOSED_NOTE });
  });

  it("an unreadable closing date creates nothing; matching still runs", async () => {
    await switchOn();
    const p = payout(2, "2026-06-28", 500);
    payout(3, "2026-06-28", 300);
    qbo.hand("H3", "2026-06-28", 300);
    qbo.closeDateFails = true;

    expect(await drain()).toMatchObject({ reconcile: { matched: 1 }, post: "unreadable" });
    expect(await rowFor(p)).toMatchObject({ status: "WAITING" });
    expect(qbo.posts).toHaveLength(0);
  });

  it("book answers 503 when the closing date can't be read, and 409 with no closing date and no switch-on", async () => {
    const p = payout(2, "2026-06-28", 500);
    await runReconcile(ORG_A, new Date("2026-07-10T12:00:00Z"));
    expect(await rowFor(p)).toMatchObject({ kind: "NO_DEPOSIT" });

    qbo.closeDateFails = true;
    await expect(resolve(p, { action: "book" })).rejects.toMatchObject({ status: 503 });
    qbo.closeDateFails = false;
    qbo.closeDate = null;
    await expect(resolve(p, { action: "book" })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("no books closing date") });
    expect(qbo.posts).toHaveLength(0);
  });

  it("with no closing date, the drain and finance's book close the same day", async () => {
    qbo.closeDate = null;
    await switchOn();
    const p = payout(2, "2026-06-29", 500);

    await drain();
    expect(await rowFor(p)).toMatchObject({ status: "OPEN", kind: "NO_DEPOSIT", qbNote: CLOSED_NOTE });
    expect(await resolve(p, { action: "book" })).toMatchObject({ status: "OPEN", kind: "NO_DEPOSIT", qbNote: CLOSED_NOTE });
    expect(qbo.posts).toHaveLength(0);
  });
});

describeDb("postPayout — claim, lookup and settle", () => {
  beforeEach(switchOn);

  const claimAt = (g: string, at: Date) =>
    db.payoutReconciliation.update({ where: { orgId_payoutGid: { orgId: ORG_A, payoutGid: g } }, data: { postClaimedAt: at } });

  it("a fresh claim keeps the drain and reconcile off the payout; a stale one is taken over", async () => {
    const p = payout(2, "2026-06-28", 500);
    await runReconcile(ORG_A, NOW);
    await claimAt(p, new Date());
    qbo.hand("H2", "2026-06-28", 500);

    expect(await drain()).toMatchObject({ reconcile: { matched: 0 }, post: { waiting: 1 } });
    expect(await rowFor(p)).toMatchObject({ status: "WAITING" });

    await claimAt(p, new Date(Date.now() - 11 * 60_000));
    await drain();
    expect(await rowFor(p)).toMatchObject({ status: "MATCHED", depositId: "H2", postClaimedAt: null });
  });

  it("finance's match and dismiss refuse a payout being posted", async () => {
    const p = payout(2, "2026-06-28", 500);
    qbo.mode = "reject";
    await drain();
    await claimAt(p, new Date());
    await expect(resolve(p, { action: "dismiss", reason: "dup" })).rejects.toMatchObject({ status: 409 });
  });

  it("a retry on an attempted payout finds its own deposit by key even after finance re-dated it", async () => {
    const p = payout(2, "2026-06-28", 500);
    qbo.mode = "accept-then-drop";
    await drain();
    expect(await rowFor(p)).toMatchObject({ kind: "POST_FAILED" });
    const own = qbo.deposits.at(-1);
    if (!own) throw new Error("no deposit");
    own.TxnDate = "2026-08-15";
    qbo.mode = "ok";

    expect(await resolve(p, { action: "retry" })).toMatchObject({ status: "POSTED", origin: "created", depositId: own.Id, depositTxnDate: "2026-08-15" });
    expect(qbo.posts).toHaveLength(1);
  });

  it("an own deposit another payout holds goes to finance with a note; nothing is created", async () => {
    const p = payout(2, "2026-06-28", 500);
    qbo.mode = "accept-then-drop";
    await drain();
    const own = qbo.deposits.at(-1)?.Id;
    const other = await db.payoutReconciliation.create({
      data: { orgId: ORG_A, payoutGid: gid(3), payoutDate: "2026-06-20", payoutNetCents: 999, status: "RESOLVED", depositId: own },
    });
    qbo.mode = "ok";

    expect(await resolve(p, { action: "retry" })).toMatchObject({
      status: "OPEN", kind: "AMBIGUOUS_DEPOSIT", qbNote: `app entry ${own} is held by payout ${other.id}`,
    });
    expect(qbo.posts).toHaveLength(1);
  });

  it("a full page of new deposits means the app may have booked it: finance's queue, nothing created", async () => {
    const p = payout(2, "2026-06-28", 500);
    qbo.mode = "reject";
    await drain();
    qbo.mode = "ok";
    for (let i = 0; i < 10_000; i++) qbo.hand(`N${i}`, "2026-01-01", 1, "99");

    expect(await resolve(p, { action: "retry" })).toMatchObject({ status: "OPEN", kind: "AMBIGUOUS_DEPOSIT", qbNote: expect.stringContaining("may already have booked") });
    expect(qbo.posts).toHaveLength(1);
  });

  it("a post that loses its claim after creating leaves finance a note to void the entry", async () => {
    const p = payout(2, "2026-06-28", 500);
    qbo.onCreate = async () => void (await claimAt(p, new Date(Date.now() + 1000)));

    expect(await drain()).toMatchObject({ post: { failed: 1, posted: 0 } });
    const created = qbo.deposits.at(-1)?.Id;
    expect(await rowFor(p)).toMatchObject({ status: "WAITING", depositId: null, qbNote: `app entry ${created} may need voiding: its post lost the payout to another` });
    expect(await db.incomeAuditLog.count({ where: { action: "reconciliation.lost_claim" } })).toBe(1);
  });

  it("finance's dismiss takes over a stalled post; its late create leaves a note that keeps the payout in the queue", async () => {
    const p = payout(2, "2026-06-28", 500);
    qbo.mode = "reject";
    await drain();
    qbo.mode = "ok";
    qbo.onCreate = async () => {
      // The post has stalled past its claim when finance dismisses.
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 11 * 60_000 });
      try {
        await resolve(p, { action: "dismiss", reason: "booked by hand" });
      } finally {
        vi.useRealTimers();
      }
    };

    await resolve(p, { action: "retry" });
    const created = qbo.deposits.at(-1)?.Id;
    expect(await rowFor(p)).toMatchObject({
      status: "RESOLVED", resolution: "DISMISSED", reason: "booked by hand", depositId: null,
      qbNote: `app entry ${created} may need voiding: its post lost the payout to another`,
    });
    expect((await reconciliationService.listQueue(ORG_A)).map((r) => r.payoutGid)).toEqual([p]);
    expect(await reconciliationService.countQueue(ORG_A)).toBe(1);

    await expect(resolve(p, { action: "clear_note", reason: " " })).rejects.toMatchObject({ status: 400 });
    expect(await resolve(p, { action: "clear_note", reason: "voided in QuickBooks" })).toMatchObject({ status: "RESOLVED", qbNote: null });
    expect(await db.incomeAuditLog.findFirstOrThrow({ where: { action: "reconciliation.note_cleared" } })).toMatchObject({ reason: "voided in QuickBooks", actorUserId: 9 });
    expect(await reconciliationService.countQueue(ORG_A)).toBe(0);
    await expect(resolve(p, { action: "clear_note", reason: "again" })).rejects.toMatchObject({ status: 409 });
  });

  it("a deposit another payout settles onto first goes to finance with a note, never throws", async () => {
    const p = payout(2, "2026-06-28", 500);
    qbo.mode = "reject";
    await drain();
    qbo.mode = "ok";
    qbo.hand("H2", "2026-06-28", 500);
    let reads = 0;
    let other = 0;
    // The second dated read is the post's own, after findOrCreate matched H2 and before it settles.
    qbo.onWindowRead = async () => {
      if (++reads !== 2) return;
      other = (await db.payoutReconciliation.create({
        data: { orgId: ORG_A, payoutGid: gid(9), payoutDate: "2026-06-28", payoutNetCents: 500, status: "RESOLVED", depositId: "H2" },
      })).id;
    };

    expect(await resolve(p, { action: "retry" })).toMatchObject({
      status: "OPEN", kind: "AMBIGUOUS_DEPOSIT", depositId: null, postClaimedAt: null, qbNote: `deposit H2 is already held by payout ${other}`,
    });
    expect(qbo.posts).toHaveLength(1);

    // Past its window, reconcile never turns it back into a bookable NO_DEPOSIT.
    await runReconcile(ORG_A, new Date("2026-07-20T12:00:00Z"));
    expect(await rowFor(p)).toMatchObject({ kind: "AMBIGUOUS_DEPOSIT", qbNote: `deposit H2 is already held by payout ${other}` });
  });

  it("an own deposit that carries a second app key is never taken as the payout's own", async () => {
    const p = payout(2, "2026-06-28", 500);
    qbo.mode = "accept-then-drop";
    await drain();
    const own = qbo.deposits.at(-1);
    if (!own) throw new Error("no deposit");
    own.PrivateNote = `${own.PrivateNote} [checkin:${qbKey("income", gid(7))}]`;
    own.TxnDate = "2026-08-15";
    qbo.mode = "ok";

    expect(await resolve(p, { action: "retry" })).toMatchObject({
      status: "OPEN", kind: "AMBIGUOUS_DEPOSIT", depositId: null, qbNote: `the app may already have booked this payout: deposit ${own.Id} carries more than one app key`,
    });
    expect(qbo.posts).toHaveLength(1);
  });

  it("a warning about another stray app entry survives a failed retry and a later post", async () => {
    const p = payout(2, "2026-06-28", 500);
    qbo.mode = "reject";
    await drain();
    const warning = "app entry 999 is not linked; void or link it";
    await db.payoutReconciliation.update({ where: { orgId_payoutGid: { orgId: ORG_A, payoutGid: p } }, data: { qbNote: warning } });

    await resolve(p, { action: "retry" });
    expect(await rowFor(p)).toMatchObject({ kind: "POST_FAILED", qbNote: warning });
    qbo.mode = "ok";
    expect(await resolve(p, { action: "retry" })).toMatchObject({ status: "POSTED", qbNote: warning });
  });

  it("an attempted payout is never matched by amount in reconcile; finance's match looks up first", async () => {
    const p = payout(2, "2026-06-28", 500);
    qbo.mode = "reject";
    await drain();
    qbo.mode = "ok";
    qbo.hand("H2", "2026-06-28", 500);

    await drain();
    expect(await rowFor(p)).toMatchObject({ status: "OPEN", kind: "AMBIGUOUS_DEPOSIT", depositId: null, qbNote: ATTEMPTED_MATCH_NOTE });
    expect(await resolve(p, { action: "match", depositId: "H2" })).toMatchObject({ status: "RESOLVED", depositId: "H2", qbNote: null });
  });

  it("a drifted app-created payout can be dismissed; the lookup never re-links the drifted deposit", async () => {
    const p = payout(2, "2026-06-28", 500);
    await drain();
    expect(await rowFor(p)).toMatchObject({ status: "POSTED" });
    setPayout(p, { netCents: 450 });
    await drain();
    expect(await rowFor(p)).toMatchObject({ status: "OPEN", kind: "DRIFT", depositId: null });

    expect(await resolve(p, { action: "dismiss", reason: "refund netted by hand" })).toMatchObject({ status: "RESOLVED", resolution: "DISMISSED", depositId: null });
  });

  it("finance's dismiss on an attempted payout links the app's own deposit instead", async () => {
    const p = payout(2, "2026-06-28", 500);
    qbo.mode = "accept-then-drop";
    await drain();
    const own = qbo.deposits.at(-1);
    if (!own) throw new Error("no deposit");
    own.TxnDate = "2026-08-15";
    qbo.mode = "ok";

    const row = await resolve(p, { action: "dismiss", reason: "booked elsewhere" });
    expect(row).toMatchObject({ status: "POSTED", origin: "created", depositId: own.Id, resolution: "AUTO", qbNote: expect.stringContaining("not applied") });
    expect(await db.incomeAuditLog.count({ where: { action: "reconciliation.dismissed" } })).toBe(0);
  });

  it("finance's match on an attempted payout answers 503 when the lookup can't read QuickBooks", async () => {
    const p = payout(2, "2026-06-28", 500);
    qbo.mode = "reject";
    await drain();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
    await expect(resolve(p, { action: "match", depositId: "H9" })).rejects.toMatchObject({ status: 503 });
  });

  it("dismiss on a payout never attempted needs no lookup", async () => {
    const p = payout(2, "2026-06-10", 500);
    await runReconcile(ORG_A, NOW);
    await db.payoutReconciliation.update({ where: { orgId_payoutGid: { orgId: ORG_A, payoutGid: p } }, data: { status: "OPEN", kind: "NO_DEPOSIT" } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
    expect(await resolve(p, { action: "dismiss", reason: "refunded" })).toMatchObject({ status: "RESOLVED", resolution: "DISMISSED" });
  });
});

describeDb("runIncomeOrphanSweep", () => {
  beforeEach(switchOn);

  it("notes an app-keyed deposit its payout does not hold, once, and leaves linked ones alone", async () => {
    const linked = payout(2, "2026-06-28", 500);
    const stray = payout(3, "2026-06-28", 300);
    await drain();
    expect(await rowFor(linked)).toMatchObject({ status: "POSTED" });
    const strayEntry = (await rowFor(stray)).depositId;
    await db.payoutReconciliation.update({
      where: { orgId_payoutGid: { orgId: ORG_A, payoutGid: stray } },
      data: { status: "OPEN", kind: "DRIFT", depositId: null, origin: null },
    });

    expect(await runIncomeOrphanSweep(ORG_A, new Date())).toMatchObject({ status: "ran", read: 2, flagged: 1, full: false });
    expect(await rowFor(stray)).toMatchObject({ qbNote: `app entry ${strayEntry} is not linked; void or link it` });
    expect((await rowFor(linked)).qbNote).toBeNull();
    expect(await runIncomeOrphanSweep(ORG_A, new Date())).toMatchObject({ flagged: 0 });
    expect(sweepAlerts).toHaveLength(0);
  });

  /** A posted payout whose row no longer holds the deposit the app created for it. */
  async function unlinked(): Promise<{ g: string; entry: string }> {
    const g = payout(3, "2026-06-28", 300);
    await drain();
    const entry = (await rowFor(g)).depositId;
    if (!entry) throw new Error("not posted");
    await db.payoutReconciliation.update({
      where: { orgId_payoutGid: { orgId: ORG_A, payoutGid: g } },
      data: { status: "OPEN", kind: "DRIFT", depositId: null, origin: null },
    });
    return { g, entry };
  }

  it("does not note again an entry whose note finance cleared", async () => {
    const { g, entry } = await unlinked();
    expect(await runIncomeOrphanSweep(ORG_A, new Date())).toMatchObject({ flagged: 1 });
    await resolve(g, { action: "clear_note", reason: "voiding it" });
    const cleared = await db.incomeAuditLog.findFirstOrThrow({ where: { action: "reconciliation.note_cleared" } });
    expect(JSON.parse(cleared.after ?? "{}")).toMatchObject({ answeredEntries: [`Deposit:${entry}`] });

    expect(await runIncomeOrphanSweep(ORG_A, new Date())).toMatchObject({ flagged: 0 });
    expect((await rowFor(g)).qbNote).toBeNull();
  });

  it("does not note again an entry on a drift finance dismissed", async () => {
    const { g } = await unlinked();
    expect(await runIncomeOrphanSweep(ORG_A, new Date())).toMatchObject({ flagged: 1 });
    expect(await resolve(g, { action: "dismiss", reason: "booked by hand" })).toMatchObject({ resolution: "DISMISSED", qbNote: null });

    expect(await runIncomeOrphanSweep(ORG_A, new Date())).toMatchObject({ flagged: 0 });
    expect((await rowFor(g)).qbNote).toBeNull();
  });

  it("does not note an entry whose lost-claim warning finance cleared", async () => {
    const { g, entry } = await unlinked();
    await db.payoutReconciliation.update({
      where: { orgId_payoutGid: { orgId: ORG_A, payoutGid: g } },
      data: { qbNote: `app entry ${entry} may need voiding: its post lost the payout to another` },
    });
    await resolve(g, { action: "clear_note", reason: "voided" });

    expect(await runIncomeOrphanSweep(ORG_A, new Date())).toMatchObject({ flagged: 0 });
    expect((await rowFor(g)).qbNote).toBeNull();
  });

  it("does not note an entry finance excluded from matching", async () => {
    const { g, entry } = await unlinked();
    await db.incomeQbMatchExclusion.create({ data: { orgId: ORG_A, qbTxnId: entry, reason: "void", excludedByUserId: 9 } });

    expect(await runIncomeOrphanSweep(ORG_A, new Date())).toMatchObject({ flagged: 0 });
    expect((await rowFor(g)).qbNote).toBeNull();
  });

  it("does not note a voided entry, which keeps its memo at a zero total", async () => {
    const { g, entry } = await unlinked();
    const voided = qbo.deposits.find((d) => d.Id === entry);
    if (!voided) throw new Error("no deposit");
    voided.TotalAmt = 0;

    expect(await runIncomeOrphanSweep(ORG_A, new Date())).toMatchObject({ flagged: 0 });
    expect((await rowFor(g)).qbNote).toBeNull();
  });

  it("a link finance commits while the sweep waits on the lock wins", async () => {
    const { g, entry } = await unlinked();
    let release = () => {};
    const released = new Promise<void>((r) => (release = r));
    let locked = () => {};
    const isLocked = new Promise<void>((r) => (locked = r));
    const link = db.$transaction(
      async (tx) => {
        await lockReconciliation(tx, ORG_A, true);
        locked();
        await released;
        await tx.payoutReconciliation.update({
          where: { orgId_payoutGid: { orgId: ORG_A, payoutGid: g } },
          data: { status: "RESOLVED", kind: null, depositId: entry },
        });
      },
      { timeout: 30_000 },
    );
    await isLocked;
    const sweep = runIncomeOrphanSweep(ORG_A, new Date());
    await new Promise((r) => setTimeout(r, 300));
    release();
    await link;

    expect(await sweep).toMatchObject({ flagged: 0 });
    expect(await rowFor(g)).toMatchObject({ depositId: entry, qbNote: null });
  });

  it("checks every app key an entry carries", async () => {
    const a = payout(2, "2026-06-28", 500);
    const b = payout(3, "2026-06-28", 300);
    await drain();
    const aEntry = (await rowFor(a)).depositId;
    const entry = qbo.deposits.find((d) => d.Id === aEntry);
    if (!entry) throw new Error("no deposit");
    entry.PrivateNote = `${entry.PrivateNote} [checkin:${qbKey("income", b)}]`;

    expect(await runIncomeOrphanSweep(ORG_A, new Date())).toMatchObject({ flagged: 1 });
    expect(await rowFor(b)).toMatchObject({ status: "POSTED", qbNote: `app entry ${aEntry} is not linked; void or link it` });
    expect((await rowFor(a)).qbNote).toBeNull();
  });

  it("alerts finance when the read reaches its cap", async () => {
    payout(2, "2026-06-28", 500);
    await drain();
    for (let i = 0; i < 10_000; i++) qbo.hand(`N${i}`, "2026-01-01", 1, "99");
    expect(await runIncomeOrphanSweep(ORG_A, new Date())).toMatchObject({ full: true });
    expect(sweepAlerts).toEqual([expect.objectContaining({ orgId: ORG_A })]);
  });

  it("answers unbound, never throws, while the host has not configured income", async () => {
    incomeRuntime.reset();
    expect(await runIncomeOrphanSweep(ORG_A, new Date())).toEqual({ status: "unbound" });
  });

  it("reads nothing when no payout was attempted in the last 30 days", async () => {
    expect(await runIncomeOrphanSweep(ORG_A, new Date())).toEqual({ status: "ran", read: 0, flagged: 0, full: false });
  });
});

describeDb("drainIncomeOutbox — every findOrCreate outcome", () => {
  beforeEach(switchOn);

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

    expect(await runReconcile(ORG_A, NOW)).toMatchObject({ matched: 0 });
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

  it("never posts a payout seen before switch-on once it is older than its match window", async () => {
    const p = payout(2, "2026-06-10", 500);
    await db.payoutReconciliation.create({
      data: { orgId: ORG_A, payoutGid: p, payoutDate: "2026-06-10", payoutNetCents: 500, status: "WAITING", createdAt: new Date("2026-06-10T12:00:00Z") },
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
  beforeEach(switchOn);

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
    // A fitting deposit that carries another payout's key goes to finance, never matched or created.
    expect(await rowFor(p3)).toMatchObject({ status: "OPEN", kind: "AMBIGUOUS_DEPOSIT", depositId: null, origin: null });
    expect(qbo.posts).toHaveLength(1);
    expect(await db.incomeAuditLog.count({ where: { action: "reconciliation.matched" } })).toBe(0);
  });
});

describeDb("drainIncomeOutbox — deposit lines", () => {
  beforeEach(switchOn);

  function orderPayout(n: number) {
    const g = payout(n, "2026-06-28", 0);
    // Charge 10000 over two lines (6000 mapped, 4000 unmapped), fee 320; a 150 adjustment.
    txns[g] = [
      { txnGid: `${g}/c`, type: "charge", orderGid: "O9", orderName: "#9", amountCents: 10000, feeCents: 320, netCents: 9680, source: "api" },
      { txnGid: `${g}/a`, type: "adjustment", orderGid: null, orderName: null, amountCents: 150, feeCents: 0, netCents: 150, source: "api" },
    ];
    setPayout(g, { netCents: 9830 });
    orderLines.push(
      { orderGid: "O9", variantId: "V1", title: "Camp", sku: null, quantity: 2, currentQuantity: 2, priceCents: 3000, discountCents: 0 },
      { orderGid: "O9", variantId: "V2", title: "Shirt", sku: null, quantity: 1, currentQuantity: 1, priceCents: 4000, discountCents: 0 },
    );
    return g;
  }

  it("splits each charge by order line to its bucket's Class; general income, fees and adjustments book at org level; sums to net", async () => {
    const g = orderPayout(2);
    owners = [{ id: 7, name: "Camp", archivedAt: null, quickBooksClassId: "700" }];
    await db.incomeItemCategory.create({ data: { orgId: ORG_A, variantId: "V1", budgetOwnerId: 7 } });
    await db.incomeItemCategory.create({ data: { orgId: ORG_A, variantId: "V2", budgetOwnerId: null } });

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

  const camp = { id: 7, name: "Camp", archivedAt: null, quickBooksClassId: "700" };
  const general = () => db.incomeItemCategory.create({ data: { orgId: ORG_A, variantId: "V2", budgetOwnerId: null } });

  it("an undecided item holds the payout as NEEDS_MAPPING; it never becomes NO_DEPOSIT, and deciding releases it on the next run", async () => {
    const g = orderPayout(2);
    owners = [camp];
    await db.incomeItemCategory.create({ data: { orgId: ORG_A, variantId: "V1", budgetOwnerId: 7 } });

    expect(await drain()).toMatchObject({ post: { held: 1, posted: 0 } });
    expect(await rowFor(g)).toMatchObject({ status: "OPEN", kind: "NEEDS_MAPPING", reason: "undecided items: V2" });

    // Long past the match window, a held payout stays held.
    const late = new Date("2026-07-20T12:00:00Z");
    await drain(late);
    await runReconcile(ORG_A, late);
    expect(await rowFor(g)).toMatchObject({ status: "OPEN", kind: "NEEDS_MAPPING" });
    expect(qbo.posts).toHaveLength(0);
    expect(await db.incomeAuditLog.count({ where: { action: "reconciliation.needs_mapping" } })).toBe(1);

    await itemCategoryService.setCategory(ORG_A, "V2", null, { userId: 1 });
    expect(await drain(late)).toMatchObject({ post: { posted: 1, held: 0 } });
    expect(await rowFor(g)).toMatchObject({ status: "POSTED", kind: null, reason: null, depositTotalCents: 9830 });
  });

  it("an item marked general income books without a Class and is not held", async () => {
    const g = orderPayout(2);
    await db.incomeItemCategory.create({ data: { orgId: ORG_A, variantId: "V1", budgetOwnerId: null } });
    await general();

    expect(await drain()).toMatchObject({ post: { posted: 1, held: 0 } });
    expect(await rowFor(g)).toMatchObject({ status: "POSTED" });
    expect(qbo.posts[0].body.Line.every((l) => l.DepositLineDetail.ClassRef === undefined)).toBe(true);
  });

  it("a held payout finance books by hand is matched", async () => {
    const g = orderPayout(2);
    await drain();
    expect(await rowFor(g)).toMatchObject({ kind: "NEEDS_MAPPING" });

    qbo.hand("H2", "2026-06-28", 9830);
    await drain();
    expect(await rowFor(g)).toMatchObject({ status: "MATCHED", depositId: "H2" });
    expect(qbo.posts).toHaveLength(0);
  });

  it.each([
    ["archived", { ...camp, archivedAt: new Date("2026-01-01") }, ["700"], "is archived"],
    ["without a Class", { ...camp, quickBooksClassId: null }, ["700"], "has no QuickBooks Class"],
    ["whose Class is inactive", camp, [], "has a QuickBooks Class that is not active"],
    ["missing from the directory", null, ["700"], "is not in the bucket list"],
  ])("a bucket %s alerts once before any payout, marks its items, holds its payouts, and releases once restored", async (_label, owner, active, issue) => {
    owners = owner ? [owner] : [];
    activeClasses = active;
    await db.incomeItemCategory.create({ data: { orgId: ORG_A, variantId: "V1", budgetOwnerId: 7 } });
    await general();

    await drain();
    expect(bucketAlerts).toEqual([{ orgId: ORG_A, budgetOwnerId: 7, bucketName: owner?.name ?? null, issue, itemCount: 1 }]);
    const items = await itemCategoryService.listItems(ORG_A);
    expect(items.find((i) => i.variantId === "V1")).toMatchObject({ decision: "bucket", bucketIssue: issue });
    expect(items.find((i) => i.variantId === "V2")).toMatchObject({ decision: "general", bucketIssue: null });

    const g = orderPayout(2);
    await drain();
    expect(bucketAlerts).toHaveLength(1);
    expect(await rowFor(g)).toMatchObject({ status: "OPEN", kind: "NEEDS_MAPPING", reason: `bucket 7 ${issue}` });
    expect(qbo.posts).toHaveLength(0);

    owners = [camp];
    activeClasses = ["700"];
    await drain();
    expect(await rowFor(g)).toMatchObject({ status: "POSTED" });
    expect((await itemCategoryService.listItems(ORG_A)).find((i) => i.variantId === "V1")?.bucketIssue).toBeNull();

    // Breaking again after a restore alerts again.
    activeClasses = [];
    await drain();
    expect(bucketAlerts).toHaveLength(2);
  });

  it("a held payout seen before switch-on stays held, then goes to finance once its items are decided", async () => {
    await clearAll();
    const g = orderPayout(2);
    expect(await drain()).toMatchObject({ post: { held: 1 } });
    expect(await rowFor(g)).toMatchObject({ status: "OPEN", kind: "NEEDS_MAPPING" });
    await expect(resolve(g, { action: "book" })).rejects.toMatchObject({ status: 409 });

    await general();
    await db.incomeItemCategory.create({ data: { orgId: ORG_A, variantId: "V1", budgetOwnerId: null } });
    await drain(new Date("2026-06-30T13:00:00Z"));
    expect(await rowFor(g)).toMatchObject({ status: "OPEN", kind: "NO_DEPOSIT", qbNote: null });
    expect(qbo.posts).toHaveLength(0);
  });

  const LATE = new Date("2026-07-20T12:00:00Z");
  const withoutLines = (g: string) => {
    const lines = orderLines;
    orderLines = [];
    return { g, restore: () => void (orderLines = lines) };
  };
  const withoutOrder = (n: number) => {
    const g = payout(n, "2026-06-28", 500);
    txns[g] = [{ ...txns[g][0], orderGid: null, orderName: null }];
    orderLines = [];
    return g;
  };

  it("a charge whose order has no lines holds, stays held past the window, and books once the lines arrive", async () => {
    const { g, restore } = withoutLines(payout(2, "2026-06-28", 500));
    expect(await drain()).toMatchObject({ post: { held: 1, posted: 0 } });
    expect(await rowFor(g)).toMatchObject({ status: "OPEN", kind: "NEEDS_MAPPING", reason: "orders with no lines: O2" });

    await drain(LATE);
    await runReconcile(ORG_A, LATE);
    expect(await rowFor(g)).toMatchObject({ status: "OPEN", kind: "NEEDS_MAPPING" });
    expect(qbo.posts).toHaveLength(0);
    expect(await db.incomeAuditLog.count({ where: { action: "reconciliation.needs_mapping" } })).toBe(1);

    restore();
    expect(await drain(LATE)).toMatchObject({ post: { posted: 1, held: 0 } });
    expect(await rowFor(g)).toMatchObject({ status: "POSTED", kind: null, reason: null, depositTotalCents: 500 });
  });

  it("a charge whose order lost a line holds, and books once the line arrives", async () => {
    const g = payout(2, "2026-06-28", 500);
    orderLines = [{ ...orderLines[0], priceCents: 300 }];
    subtotals = [{ orderGid: "O2", subtotalCents: 500 }];
    expect(await drain()).toMatchObject({ post: { held: 1, posted: 0 } });
    expect(await rowFor(g)).toMatchObject({ status: "OPEN", kind: "NEEDS_MAPPING", reason: "orders with missing lines: O2" });
    expect(qbo.posts).toHaveLength(0);

    orderLines.push({ ...orderLines[0], priceCents: 200 });
    expect(await drain()).toMatchObject({ post: { posted: 1, held: 0 } });
    expect(await rowFor(g)).toMatchObject({ status: "POSTED", reason: null });
  });

  it("lines that arrive with an undecided item move the hold's reason to that item", async () => {
    const g = orderPayout(2);
    const { restore } = withoutLines(g);
    await drain();
    expect(await rowFor(g)).toMatchObject({ reason: "orders with no lines: O9" });

    restore();
    await drain();
    expect(await rowFor(g)).toMatchObject({ kind: "NEEDS_MAPPING", reason: "undecided items: V1, V2" });
    expect(qbo.posts).toHaveLength(0);
  });

  it("a charge with no order holds past the window and book refuses it", async () => {
    const g = withoutOrder(2);
    const reason = `transactions with no order: ${g}/t`;
    expect(await drain()).toMatchObject({ post: { held: 1, posted: 0 } });
    expect(await rowFor(g)).toMatchObject({ status: "OPEN", kind: "NEEDS_MAPPING", reason });

    await drain(LATE);
    expect(await rowFor(g)).toMatchObject({ status: "OPEN", kind: "NEEDS_MAPPING", reason });
    await expect(resolve(g, { action: "book" })).rejects.toMatchObject({ status: 409 });
    expect(qbo.posts).toHaveLength(0);
  });

  it("finance settles a charge with no order by a hand-booked deposit, which the next run matches", async () => {
    const g = withoutOrder(2);
    await drain();

    qbo.hand("H2", "2026-06-28", 500);
    await drain();
    expect(await rowFor(g)).toMatchObject({ status: "MATCHED", kind: null, depositId: "H2" });
    expect(qbo.posts).toHaveLength(0);
  });

  it("finance settles a charge with no order by matching a deposit of another amount, with a reason", async () => {
    const g = withoutOrder(2);
    await drain();

    qbo.hand("H2", "2026-06-28", 450);
    await expect(resolve(g, { action: "match", depositId: "H2" })).rejects.toMatchObject({ status: 400 });
    expect(await resolve(g, { action: "match", depositId: "H2", reason: "booked net of a fee" })).toMatchObject({ status: "RESOLVED", kind: null, depositId: "H2" });

    await drain();
    expect(await rowFor(g)).toMatchObject({ status: "RESOLVED", depositId: "H2" });
    expect(qbo.posts).toHaveLength(0);
  });

  it("finance settles a charge with no order by dismissing it, and later runs leave it dismissed", async () => {
    const g = withoutOrder(2);
    await drain();

    await expect(resolve(g, { action: "dismiss", reason: " " })).rejects.toMatchObject({ status: 400 });
    expect(await resolve(g, { action: "dismiss", reason: "booked in the prior year" })).toMatchObject({ status: "RESOLVED", resolution: "DISMISSED", kind: null });

    expect(await drain()).toMatchObject({ post: { posted: 0, held: 0 } });
    expect(await rowFor(g)).toMatchObject({ status: "RESOLVED", resolution: "DISMISSED" });
    expect(qbo.posts).toHaveLength(0);
  });

  it("booking a NO_DEPOSIT payout whose lines are gone holds it and names the gap", async () => {
    await clearAll();
    const g = payout(2, "2026-06-28", 500);
    await drain();
    expect(await rowFor(g)).toMatchObject({ kind: "NO_DEPOSIT" });

    orderLines = [];
    await expect(resolve(g, { action: "book" })).rejects.toMatchObject({ status: 409, message: "The payout is held: orders with no lines: O2" });
    expect(await rowFor(g)).toMatchObject({ kind: "NEEDS_MAPPING", reason: "orders with no lines: O2" });
    expect(qbo.posts).toHaveLength(0);
  });

  it("a held payout whose net changes tracks the new net and stays held", async () => {
    const g = orderPayout(2);
    await drain();
    expect(await rowFor(g)).toMatchObject({ kind: "NEEDS_MAPPING", payoutNetCents: 9830 });

    setPayout(g, { netCents: 9700 });
    await runReconcile(ORG_A, NOW);
    expect(await rowFor(g)).toMatchObject({ status: "OPEN", kind: "NEEDS_MAPPING", payoutNetCents: 9700 });
    const audits = await db.incomeAuditLog.findMany({ where: { action: "reconciliation.needs_mapping", reason: "payout_amount" } });
    expect(audits).toHaveLength(1);
  });

  it("while the Classes can't be read, only payouts with a bucketed sale hold, and no alert fires", async () => {
    owners = [camp];
    bind({ classes: { activeClassIds: async () => { throw new Error("socket hang up"); } } });
    await db.incomeItemCategory.create({ data: { orgId: ORG_A, variantId: "V1", budgetOwnerId: 7 } });
    await general();
    const held = orderPayout(2);
    const plain = payout(3, "2026-06-28", 500);

    expect(await drain()).toMatchObject({ post: { held: 1, posted: 1 } });
    expect(await rowFor(held)).toMatchObject({ kind: "NEEDS_MAPPING", reason: "bucket 7 can't be checked: QuickBooks Classes can't be read" });
    expect(await rowFor(plain)).toMatchObject({ status: "POSTED" });
    expect(bucketAlerts).toHaveLength(0);
    expect(await db.incomeAuditLog.count({ where: { entityType: "budget_owner" } })).toBe(0);

    bind();
    await drain();
    expect(await rowFor(held)).toMatchObject({ status: "POSTED" });
  });

  it("an alert send that fails is not retried: the bucket stays recorded", async () => {
    owners = [{ ...camp, quickBooksClassId: null }];
    let sends = 0;
    bind({ alerts: { postCapReached: async () => {}, bucketUnusable: async () => { sends++; throw new Error("SES down"); }, sweepIncomplete: async () => {} } });
    await db.incomeItemCategory.create({ data: { orgId: ORG_A, variantId: "V1", budgetOwnerId: 7 } });

    await drain();
    await drain();
    expect(sends).toBe(1);
    expect(await db.incomeAuditLog.count({ where: { action: "bucket.unusable" } })).toBe(1);
  });

  it("reassigning a broken bucket's items releases the payout without touching the bucket", async () => {
    owners = [{ ...camp, quickBooksClassId: null }];
    await db.incomeItemCategory.create({ data: { orgId: ORG_A, variantId: "V1", budgetOwnerId: 7 } });
    await general();
    const g = orderPayout(2);
    await drain();
    expect(await rowFor(g)).toMatchObject({ kind: "NEEDS_MAPPING" });

    await itemCategoryService.setCategory(ORG_A, "V1", null, { userId: 1 });
    await drain();
    expect(await rowFor(g)).toMatchObject({ status: "POSTED" });
    expect(bucketAlerts).toHaveLength(1);
  });
});

describeDb("item assignment", () => {
  const actor = { userId: 1 };
  const assign = (id: number | null) => itemCategoryService.setCategory(ORG_A, "V1", id, actor);

  it("assigns to a live bucket with an active Class, or to general income", async () => {
    owners = [{ id: 7, name: "Camp", archivedAt: null, quickBooksClassId: "700" }];
    expect(await assign(7)).toMatchObject({ budgetOwnerId: 7 });
    expect(await assign(null)).toMatchObject({ budgetOwnerId: null });
    expect(await db.incomeAuditLog.count({ where: { action: "item_category.set" } })).toBe(2);
  });

  it.each([
    ["archived", { id: 7, name: "Camp", archivedAt: new Date("2026-01-01"), quickBooksClassId: "700" }, ["700"], 422],
    ["without a Class", { id: 7, name: "Camp", archivedAt: null, quickBooksClassId: null }, ["700"], 422],
    ["whose Class is inactive", { id: 7, name: "Camp", archivedAt: null, quickBooksClassId: "700" }, [], 422],
  ])("refuses a bucket %s", async (_label, owner, active, status) => {
    owners = [owner];
    activeClasses = active;
    await expect(assign(7)).rejects.toMatchObject({ status: status });
    expect(await db.incomeItemCategory.count()).toBe(0);
  });

  it("refuses a bucket while QuickBooks can't be reached, but still takes general income", async () => {
    owners = [{ id: 7, name: "Camp", archivedAt: null, quickBooksClassId: "700" }];
    bind({ classes: { activeClassIds: async () => { throw new Error("socket hang up"); } } });
    await expect(assign(7)).rejects.toMatchObject({ status: 503 });
    bind({ classes: undefined });
    await expect(assign(7)).rejects.toMatchObject({ status: 503 });
    expect(await assign(null)).toMatchObject({ budgetOwnerId: null });
  });
});

describeDb("drainIncomeOutbox — mirror reverts and binding", () => {
  beforeEach(switchOn);

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
    configureIncome({ mirror, deposits: quickBooksDepositSource(tokens, realm), booksMap: shopifyMap });
    await runReconcile(ORG_A, NOW);
    expect((await rowFor(p)).status).toBe("WAITING");

    setPayout(p, { status: "in_transit" });
    bind();
    expect(await drain()).toMatchObject({ post: { posted: 0 } });
    expect(qbo.posts).toHaveLength(0);
  });

  it("creates nothing until the mirror is declared newest-wins", async () => {
    bind({ posting: { client: new QuickBooksClient(tokens, realm), mirrorNewestWins: false } });
    const p = payout(2, "2026-06-28", 500);
    expect(await drain()).toMatchObject({ reconcile: { status: "ran" }, post: "gated" });
    expect(await rowFor(p)).toMatchObject({ status: "WAITING" });
    expect(qbo.posts).toHaveLength(0);
  });

  it("creates nothing while the finance alert is unbound", async () => {
    bind({ alerts: undefined });
    const p = payout(2, "2026-06-28", 500);
    expect(await drain()).toMatchObject({ reconcile: { status: "ran", matched: 0 }, post: "unbound" });
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
    expect(await drain()).toMatchObject({ reconcile: { status: "ran", matched: 0 }, post: "unbound" });
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
});

describeDb("income settings", () => {
  const finance = { userId: 9, username: "fin", isFinance: true, isBoard: false };
  const board = { userId: 8, isFinance: false, isBoard: true };

  it("defaults to 25 creates and $25,000 per run for each source", async () => {
    await expect(updateIncomeSettings(ORG_A, {}, finance)).resolves.toEqual({
      maxCreatesPerRun: 25,
      maxCreateCentsPerRun: 2_500_000,
      benevityMaxCreateCentsPerRun: 2_500_000,
    });
  });

  it("finance may lower a cap; raising one takes the board; each change is audited", async () => {
    await updateIncomeSettings(ORG_A, { maxCreatesPerRun: 10 }, finance);
    await expect(updateIncomeSettings(ORG_A, { maxCreatesPerRun: 20 }, finance)).rejects.toMatchObject({ status: 403 });
    await expect(updateIncomeSettings(ORG_A, { maxCreatesPerRun: 20 }, board)).resolves.toMatchObject({ maxCreatesPerRun: 20 });
    await expect(updateIncomeSettings(ORG_A, { maxCreatesPerRun: 1 }, { userId: 7, isFinance: false, isBoard: false })).rejects.toMatchObject({ status: 403 });

    const changes = await db.incomeAuditLog.findMany({ where: { action: "settings.updated" }, orderBy: { id: "asc" } });
    expect(changes.map((c) => [c.actorUserId, c.before, c.after])).toEqual([
      [9, JSON.stringify({ maxCreatesPerRun: 25 }), JSON.stringify({ maxCreatesPerRun: 10 })],
      [8, JSON.stringify({ maxCreatesPerRun: 10 }), JSON.stringify({ maxCreatesPerRun: 20 })],
    ]);
  });
});

describeDb("a second source: Benevity deposits handed over through expectDeposit", () => {
  const BENEVITY_BANK = "36";
  const ROLES: Partial<Record<BooksMapRole, string>> = { ...SHOPIFY_ROLES, BENEVITY_BANK, BENEVITY_DONATIONS: "60", BENEVITY_MATCHES: "61", BENEVITY_FEES: "62" };
  let roleAccounts: Partial<Record<BooksMapRole, string>>;
  const booksMap: BooksMap = { accounts: async () => roleAccounts, classes: async () => new Map([[7, "700"]]) };

  /** A disbursement of a $100 gift to bucket 7 and a $50 match at organization level, less a $3 fee. */
  const disbursement = (txnDate = "2026-06-28", over: Partial<ExpectedDeposit> = {}): ExpectedDeposit => ({
    txnDate,
    netCents: 14_700,
    bankRole: "BENEVITY_BANK",
    lines: [
      { role: "BENEVITY_DONATIONS", budgetOwnerId: 7, amountCents: 10_000, description: "Benevity donations" },
      { role: "BENEVITY_MATCHES", budgetOwnerId: null, amountCents: 5_000 },
      { role: "BENEVITY_FEES", budgetOwnerId: null, amountCents: -300 },
    ],
    memo: "Benevity disbursement D1",
    ...over,
  });
  const expect1 = (key = "D1", e: ExpectedDeposit = disbursement()) => expectDeposit(ORG_A, "benevity", key, e);
  const status = async (key = "D1") => (await depositStatus(ORG_A, "benevity", [key]))[key];

  beforeEach(() => {
    roleAccounts = { ...ROLES };
    owners = [{ id: 7, name: "Camp", archivedAt: null, quickBooksClassId: "700" }];
    bind({ booksMap, org: async () => ({ id: ORG_A, name: "A" }) });
  });

  it("records a deposit once; a repeat changes nothing; a change updates it only while unposted", async () => {
    expect(await expect1()).toBe("recorded");
    expect(await expect1()).toBe("unchanged");
    expect(await rowFor("D1")).toMatchObject({ source: "benevity", status: "WAITING", payoutDate: "2026-06-28", payoutNetCents: 14_700 });
    expect(await status()).toEqual({ state: "waiting" });

    const later = disbursement("2026-06-29", { netCents: 14_800, lines: [{ role: "BENEVITY_DONATIONS", budgetOwnerId: 7, amountCents: 14_800 }] });
    expect(await expect1("D1", later)).toBe("updated");
    expect(await rowFor("D1")).toMatchObject({ payoutDate: "2026-06-29", payoutNetCents: 14_800 });

    qbo.hand("H1", "2026-06-29", 14_800, BENEVITY_BANK);
    await runReconcile(ORG_A, NOW);
    expect(await expect1("D1", disbursement())).toBe("frozen");
    expect(await rowFor("D1")).toMatchObject({ status: "MATCHED", depositId: "H1", payoutNetCents: 14_800 });
    expect(await status()).toEqual({ state: "matched", depositId: "H1", txnDate: "2026-06-29", totalCents: 14_800 });
  });

  it("refuses a deposit whose lines do not sum to its net, and answers nothing for a key it never received", async () => {
    await expect(expect1("D1", disbursement("2026-06-28", { netCents: 1 }))).rejects.toMatchObject({ status: 400 });
    expect(await depositStatus(ORG_A, "benevity", ["D1"])).toEqual({});
  });

  it("matches a hand-booked deposit in the Benevity bank inside donation's ±7-day window, never one in the Shopify bank", async () => {
    await expect1();
    qbo.hand("HS", "2026-06-23", 14_700, BANK);
    qbo.hand("HB", "2026-06-23", 14_700, BENEVITY_BANK);
    expect(await runReconcile(ORG_A, NOW)).toMatchObject({ matched: 1 });
    expect(await rowFor("D1")).toMatchObject({ status: "MATCHED", origin: "matched", depositId: "HB" });
  });

  it("creates a deposit after switch-on with its accounts and Classes from the books map, under income's Benevity key", async () => {
    await switchOn();
    await expect1();
    expect(await drain()).toMatchObject({ post: { posted: 1 } });
    expect(qbo.posts).toHaveLength(1);
    const { key, body } = qbo.posts[0];
    expect(key).toBe(qbKey("income", "benevity:D1"));
    expect(body).toMatchObject({ TxnDate: "2026-06-28", DepositToAccountRef: { value: BENEVITY_BANK } });
    expect(body.Line.map((l) => [l.Amount, l.DepositLineDetail.AccountRef.value, l.DepositLineDetail.ClassRef?.value])).toEqual([
      [100, "60", "700"],
      [50, "61", undefined],
      [-3, "62", undefined],
    ]);
    expect(await status()).toMatchObject({ state: "booked", totalCents: 14_700 });
  });

  it("skips a deposit whose role finance has not mapped, without failing it", async () => {
    await switchOn();
    delete roleAccounts.BENEVITY_FEES;
    await expect1();
    expect(await drain()).toMatchObject({ post: { posted: 0, failed: 0, waiting: 1 } });
    expect(qbo.posts).toHaveLength(0);
    expect(await rowFor("D1")).toMatchObject({ status: "WAITING", kind: null });
  });

  it("parks a Benevity deposit over its own cents cap while a Shopify payout of the same size posts", async () => {
    await updateIncomeSettings(ORG_A, { benevityMaxCreateCentsPerRun: 10_000 }, { userId: 9, isFinance: true, isBoard: false });
    roleAccounts = { ...ROLES, SHOPIFY_BANK: BANK };
    await switchOn();
    await expect1();
    const p = payout(2, "2026-06-28", 14_700);
    expect(await drain()).toMatchObject({ post: { posted: 1, over_cap: 1 } });
    expect(await rowFor("D1")).toMatchObject({ status: "OPEN", kind: "OVER_CAP" });
    expect(await rowFor(p)).toMatchObject({ status: "POSTED" });
    expect(await status()).toMatchObject({ state: "with_finance", kind: "OVER_CAP" });
  });

  it("notes a deposit uploaded after switch-on but dated in closed books", async () => {
    await switchOn();
    // Benevity's own switch-on.
    await db.incomeOrgSettings.update({ where: { orgId: ORG_A }, data: { benevityQbPostingOnAt: ON_AT } });
    await expect1("D1", disbursement("2026-05-20"));
    expect(await drain()).toMatchObject({ post: { queued: 1 } });
    expect(await rowFor("D1")).toMatchObject({
      status: "OPEN",
      kind: "NO_DEPOSIT",
      qbNote: "Uploaded after posting was switched on, but dated 2026-05-20, in closed books; skip it",
    });
  });

  it("is never drift-checked against the Shopify mirror once posted", async () => {
    await switchOn();
    await expect1();
    await drain();
    expect(await runReconcile(ORG_A, new Date("2026-07-01T12:00:00Z"))).toMatchObject({ drifted: 0 });
    expect(await rowFor("D1")).toMatchObject({ status: "POSTED" });
  });

  it("reopens as drift when its deposit changes, freeing the deposit", async () => {
    await switchOn();
    await expect1();
    await drain();
    const { depositId } = await rowFor("D1");
    qbo.deposits = qbo.deposits.map((d) => (d.Id === depositId ? { ...d, TotalAmt: 140 } : d));
    expect(await runReconcile(ORG_A, new Date("2026-07-01T12:00:00Z"))).toMatchObject({ drifted: 1 });
    expect(await rowFor("D1")).toMatchObject({ status: "OPEN", kind: "DRIFT", depositId: null });
    expect(await status()).toMatchObject({ state: "drifted" });
  });

  it("the orphan sweep reports an unlinked deposit carrying a Benevity row's key", async () => {
    await switchOn();
    await expect1();
    await drain();
    qbo.deposits.push({ Id: "X9", TxnDate: "2026-06-28", TotalAmt: 147, DepositToAccountRef: { value: BENEVITY_BANK }, PrivateNote: `[checkin:${qbKey("income", "benevity:D1")}]` });
    qbo.createdAt.set("X9", Date.now());
    expect(await runIncomeOrphanSweep(ORG_A, new Date())).toMatchObject({ flagged: 1 });
    expect((await rowFor("D1")).qbNote).toBe("app entry X9 is not linked; void or link it");
  });

  const settings = () => db.incomeOrgSettings.findUniqueOrThrow({ where: { orgId: ORG_A } });

  it("a Benevity row due while Shopify posting is gated stamps only Benevity; a Shopify payout seen later still ages out to finance", async () => {
    bind({ booksMap, org: async () => ({ id: ORG_A, name: "A" }), posting: { client: new QuickBooksClient(tokens, realm), mirrorNewestWins: false } });
    await expect1();
    await drain();
    expect(await settings()).toMatchObject({ qbPostingOnAt: null, benevityQbPostingOnAt: NOW });

    const p = payout(2, "2026-06-01", 500);
    await drain(new Date("2026-07-01T12:00:00Z"));
    expect(await rowFor(p)).toMatchObject({ status: "OPEN", kind: "NO_DEPOSIT" });
    expect(await settings()).toMatchObject({ qbPostingOnAt: null, benevityQbPostingOnAt: NOW });
  });

  it("Shopify's switch-on never starts Benevity's clock", async () => {
    await switchOn();
    expect(await settings()).toMatchObject({ qbPostingOnAt: ON_AT, benevityQbPostingOnAt: null });
  });

  it("a Benevity source with no deposit yet needs only its bank; a line needs its role", () => {
    expect(missingRoles({ source: "benevity", expected: null }, {})).toEqual(["BENEVITY_BANK"]);
    expect(missingRoles({ source: "benevity", expected: null }, { BENEVITY_BANK })).toEqual([]);
    const one = disbursement("2026-06-28", { lines: [{ role: "BENEVITY_DONATIONS", budgetOwnerId: null, amountCents: 14_700 }] });
    expect(missingRoles({ source: "benevity", expected: one }, { BENEVITY_BANK })).toEqual(["BENEVITY_DONATIONS"]);
  });
});
