/**
 * The QuickBooks drain: completed disbursements post as bank Deposits through the real
 * QuickBooksClient over an in-memory QBO company. Match before create; the key makes a retry safe.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { QuickBooksClient, qbKey, type QboDeposit } from "@checkin/quickbooks";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { configureBulkDonation } from "../../runtime";
import type { OwnerInfo } from "../../contract";
import { makeFile, makeTransaction, TEST_ORG_ID } from "../helpers/factories";
import { QB_MATCHED_EVENT, QB_MATCH_STATE } from "../../lib/qb-match";
import {
  MAX_CREATES_PER_DAY, MAX_CREATES_PER_RUN, MAX_CREATE_CENTS_PER_RUN, MAX_DRIFT_CHECKS_PER_RUN, MAX_POST_ATTEMPTS, QB_DRIFT_CAUSE,
  QB_EVENT, STALE_CLAIM_MS,
  donationClaimedDepositIds, postDisbursementToQb, qbGate, qbPostingOnAt, runDonationQbPosting,
} from "../../lib/qb-poster";
import { disbursements } from "../../routes";

const orgId = TEST_ORG_ID;
const BANK = "35";
const ACCOUNTS: Record<string, string> = { "4000-Donations": "40", "4001-Match": "41", "6000-Fees": "60" };
const OWNERS: OwnerInfo[] = [
  { id: 1, name: "Robotics", archivedAt: null, quickBooksClassId: "900" },
  { id: 2, name: "No class", archivedAt: null, quickBooksClassId: null },
];

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

/** Windowed and created-since Deposit reads, Account lookups by name, and Deposit creates. */
class FakeQbo {
  deposits: QboDeposit[] = [];
  posts: { key: string; body: PostedDeposit }[] = [];
  mode: "ok" | "down" | "accept-then-drop" | "closed" = "ok";
  /** The books closing date Preferences reports. */
  closeDate: string | null = null;
  /** Preferences reads fail. */
  prefsDown = false;
  /** Created-since reads fail. */
  createdSinceDown = false;
  /** When each Deposit was created in QuickBooks; entries absent here predate every attempt. */
  createTimes = new Map<string, Date>();
  /** Runs after QuickBooks applies a create, before it answers. */
  onCreate: (() => Promise<void>) | null = null;
  /** Runs when a created-since read arrives, before it answers. */
  onCreatedSince: (() => Promise<void>) | null = null;
  private nextId = 7000;

  handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { intuit_tid: "tid" } });
    if (this.mode === "down") return json({ Fault: { Error: [{ code: "3100" }] } }, 503);
    if ((init?.method ?? "GET") === "GET") {
      const query = url.searchParams.get("query") ?? "";
      if (query === "SELECT * FROM Preferences") {
        if (this.prefsDown) return json({ Fault: { Error: [{ code: "3100" }] } }, 503);
        return json({ QueryResponse: { Preferences: [{ AccountingInfoPrefs: this.closeDate ? { BookCloseDate: this.closeDate } : {} }] } });
      }
      const account = /FROM Account WHERE FullyQualifiedName = '([^']+)'/.exec(query);
      if (account) {
        const Id = ACCOUNTS[account[1]];
        return json({ QueryResponse: Id ? { Account: [{ Id, Name: account[1], FullyQualifiedName: account[1] }] } : {} });
      }
      const since = /FROM Deposit WHERE MetaData\.CreateTime >= '([^']+)'/.exec(query);
      if (since) {
        if (this.createdSinceDown) return json({ Fault: { Error: [{ code: "3100" }] } }, 503);
        await this.onCreatedSince?.();
        const at = Date.parse(since[1]);
        const list = this.deposits.filter((d) => (this.createTimes.get(d.Id)?.getTime() ?? 0) >= at);
        return json({ QueryResponse: list.length ? { Deposit: list } : {} });
      }
      const m = /FROM Deposit WHERE TxnDate >= '([\d-]+)' AND TxnDate <= '([\d-]+)'/.exec(query);
      if (!m) throw new Error(`unexpected query ${query}`);
      const list = this.deposits.filter((d) => d.TxnDate >= m[1] && d.TxnDate <= m[2]);
      return json({ QueryResponse: list.length ? { Deposit: list } : {} });
    }
    if (!url.pathname.endsWith("/deposit")) throw new Error(`unexpected write ${url.pathname}`);
    if (this.mode === "closed") return json({ Fault: { Error: [{ code: "6210" }] } }, 400);
    const body = JSON.parse(String(init?.body)) as PostedDeposit;
    this.posts.push({ key: url.searchParams.get("requestid") ?? "", body });
    const Id = String(this.nextId++);
    const TotalAmt = body.Line.reduce((s, l) => s + Math.round(l.Amount * 100), 0) / 100;
    this.deposits.push({ Id, TxnDate: body.TxnDate, TotalAmt, DepositToAccountRef: body.DepositToAccountRef, PrivateNote: body.PrivateNote });
    this.createTimes.set(Id, new Date());
    await this.onCreate?.();
    if (this.mode === "accept-then-drop") throw new Error("socket hang up");
    return json({ Deposit: { Id } });
  };
}

let qbo: FakeQbo;
let foreignClaims: string[];
let sweepAlerts: { orgId: string; since: Date }[];

function bind(opts: { prod?: boolean; qb?: "on" | "off" | "unbound" } = {}) {
  const client = new QuickBooksClient({ current: async () => "tok" }, { env: "sandbox", realmId: "123" });
  configureBulkDonation({
    auth: { getPrincipal: async () => ({ id: 1, name: "testfinance" }) },
    org: async () => ({ id: orgId, name: "Test Org" }),
    owners: { list: async () => OWNERS },
    qb:
      opts.qb === "unbound"
        ? undefined
        : {
            client: async () => (opts.qb === "off" ? null : client),
            bankAccountId: BANK,
            prod: opts.prod ?? false,
            sweepIncomplete: async (event) => void sweepAlerts.push(event),
          },
    otherLaneClaims: { claimedDepositIds: async () => foreignClaims },
  });
}

type Gift = { donation?: number; match?: number; fees?: number; ownerId?: number | null; org?: boolean };

/** A completed disbursement: its gifts and the event the drain posts from. */
async function completed(disbursementId: string, date: string, gifts: Gift[] = [{ donation: 1000, match: 500, fees: 50 }]) {
  const file = await makeFile(orgId);
  const items: { type: "donation" | "match" | "fees"; account: string; amountCents: number; transactionId: string }[] = [];
  for (const g of gifts) {
    const tx = await makeTransaction(orgId, file.id, {
      disbursementId,
      disbursementDate: date,
      ownerId: g.org ? null : g.ownerId === undefined ? 1 : g.ownerId,
      isOrganizationalLevel: g.org ?? false,
    });
    if (g.donation) items.push({ type: "donation", account: "4000-Donations", amountCents: g.donation, transactionId: tx.transactionId });
    if (g.match) items.push({ type: "match", account: "4001-Match", amountCents: g.match, transactionId: tx.transactionId });
    if (g.fees) items.push({ type: "fees", account: "6000-Fees", amountCents: g.fees, transactionId: tx.transactionId });
  }
  const payload = { version: 1, orgId, disbursementId, disbursementDate: date, disbursementFrom: "Benevity", items };
  return db.disbursementEvent.create({ data: { orgId, disbursementId, payload: JSON.stringify(payload) } });
}

/** Posting switched on a minute ago, and the books closed through 2026-08-31: later uploads book themselves. */
async function live(closeDate: string | null = "2026-08-31") {
  await db.donationOrgSettings.create({ data: { orgId, qbPostingOnAt: new Date(Date.now() - 60_000) } });
  qbo.closeDate = closeDate;
}

const today = () => new Date().toISOString().slice(0, 10);

const handDeposit = (Id: string, TxnDate: string, cents: number, account = BANK): QboDeposit => ({
  Id, TxnDate, TotalAmt: cents / 100, DepositToAccountRef: { value: account },
});

async function stateOf(id: number) {
  return db.disbursementEvent.findUniqueOrThrow({ where: { id }, select: { qbMatchState: true, qbTxnId: true } });
}

const rowOf = (id: number) => db.disbursementEvent.findUniqueOrThrow({ where: { id } });

function eventsOf(disbursementId: string, eventType: string) {
  return db.workflowEvent.findMany({ where: { orgId, entityId: disbursementId, eventType } });
}

beforeEach(async () => {
  await db.workflowEvent.deleteMany({});
  await db.disbursementEvent.deleteMany({});
  await db.transaction.deleteMany({});
  await db.uploadedFile.deleteMany({});
  await db.donationQbMatchExclusion.deleteMany({});
  await db.donationOrgSettings.deleteMany({});
  qbo = new FakeQbo();
  foreignClaims = [];
  sweepAlerts = [];
  vi.stubGlobal("fetch", vi.fn(qbo.handle));
  bind();
});

afterEach(() => vi.unstubAllGlobals());

describeDb("donation QuickBooks drain: outcomes", () => {
  it("before switch-on only matches: an unmatched disbursement goes to finance as UNBOOKED", async () => {
    qbo.closeDate = "2026-08-31";
    const e = await completed("TEST-D1", "2026-09-10");
    expect(await postDisbursementToQb(e.id)).toBe("queued");
    expect(qbo.posts).toHaveLength(0);
    expect(await stateOf(e.id)).toEqual({ qbMatchState: "UNBOOKED", qbTxnId: null });
    expect((await rowOf(e.id)).qbNote).toBeNull();
  });

  it("an upload from before switch-on is UNBOOKED even after the lane switches on", async () => {
    qbo.closeDate = "2026-08-31";
    const e = await completed("TEST-D1", "2026-09-10");
    await db.disbursementEvent.update({ where: { id: e.id }, data: { createdAt: new Date(Date.now() - 120_000) } });
    await live();
    expect(await postDisbursementToQb(e.id)).toBe("queued");
    expect((await stateOf(e.id)).qbMatchState).toBe("UNBOOKED");
  });

  it("after switch-on, books one bank Deposit: gifts and matches in, fees out, each line with its owner's Class", async () => {
    await live();
    const e = await completed("TEST-D1", "2026-09-10", [
      { donation: 1000, match: 500, fees: 50 },
      { donation: 2000, fees: 100 },
      { donation: 300, org: true },
    ]);

    expect(await postDisbursementToQb(e.id)).toBe("posted");

    expect(qbo.posts).toHaveLength(1);
    const { key, body } = qbo.posts[0];
    expect(key).toBe(qbKey("donation", `${orgId}:TEST-D1`));
    expect(body.TxnDate).toBe("2026-09-10");
    expect(body.DepositToAccountRef).toEqual({ value: BANK });
    const lines = body.Line.map((l) => [l.Amount, l.DepositLineDetail.AccountRef.value, l.DepositLineDetail.ClassRef?.value ?? null]);
    expect(lines).toEqual([
      [30, "40", "900"],
      [5, "41", "900"],
      [-1.5, "60", "900"],
      [3, "40", null],
    ]);
    expect(body.PrivateNote).toContain(`[checkin:${key}]`);
    expect(JSON.stringify(body)).not.toMatch(/Jane|Doe/);

    const after = await stateOf(e.id);
    expect(after.qbMatchState).toBe("CREATED");
    expect(await eventsOf("TEST-D1", QB_EVENT.CREATED)).toHaveLength(1);
    expect(await eventsOf("TEST-D1", QB_MATCHED_EVENT)).toHaveLength(0);
    expect(await donationClaimedDepositIds(orgId)).toContain(after.qbTxnId);
    expect((await rowOf(e.id)).qbCreateAttemptedAt).not.toBeNull();
  });

  it("matches a hand-booked deposit of the same net in the bank account, writes QB_MATCHED, and stores the deposit's date", async () => {
    await live();
    const e = await completed("TEST-D1", "2026-09-10");
    qbo.deposits.push(handDeposit("501", "2026-09-12", 1450), handDeposit("502", "2026-09-12", 1450, "99"));

    expect(await postDisbursementToQb(e.id)).toBe("matched");

    expect(qbo.posts).toHaveLength(0);
    expect(await stateOf(e.id)).toEqual({ qbMatchState: "MATCHED", qbTxnId: "501" });
    expect(await eventsOf("TEST-D1", QB_MATCHED_EVENT)).toHaveLength(1);
    expect(await rowOf(e.id)).toMatchObject({ qbDepositTotalCents: 1450, qbDepositTxnDate: "2026-09-12" });
  });

  it("matches in closed books and before switch-on, since a match changes nothing in QuickBooks", async () => {
    qbo.closeDate = "2026-09-30";
    const e = await completed("TEST-D1", "2026-09-10");
    qbo.deposits.push(handDeposit("501", "2026-09-12", 1450));
    expect(await postDisbursementToQb(e.id)).toBe("matched");
    expect(await stateOf(e.id)).toEqual({ qbMatchState: "MATCHED", qbTxnId: "501" });
  });

  it("sends two equal candidates to finance, never a guess", async () => {
    const e = await completed("TEST-D1", "2026-09-10");
    qbo.deposits.push(handDeposit("501", "2026-09-09", 1450), handDeposit("502", "2026-09-11", 1450));
    expect(await postDisbursementToQb(e.id)).toBe("queued");
    expect((await stateOf(e.id)).qbMatchState).toBe("AMBIGUOUS");
  });

  it("an upload after switch-on dated in closed books goes to finance as UNBOOKED, with a note", async () => {
    await live("2026-09-20");
    const e = await completed("TEST-D1", "2026-09-10");
    expect(await postDisbursementToQb(e.id)).toBe("queued");
    expect(await rowOf(e.id)).toMatchObject({ qbMatchState: "UNBOOKED", qbNote: expect.stringContaining("closed books") });
    expect(qbo.posts).toHaveLength(0);
  });

  it("with no books closing date, nothing dated before switch-on is created", async () => {
    await live(null);
    const old = await completed("TEST-OLD", "2026-09-10");
    const fresh = await completed("TEST-NEW", today());
    expect(await postDisbursementToQb(old.id)).toBe("queued");
    expect((await stateOf(old.id)).qbMatchState).toBe("UNBOOKED");
    expect(await postDisbursementToQb(fresh.id)).toBe("posted");
    expect(qbo.posts.map((p) => p.body.TxnDate)).toEqual([today()]);
  });

  it("a failed closing-date read creates nothing and leaves the record as it was, but still matches", async () => {
    await live();
    qbo.prefsDown = true;
    const miss = await completed("TEST-MISS", "2026-09-10");
    const hit = await completed("TEST-HIT", "2026-09-20", [{ donation: 2000 }]);
    qbo.deposits.push(handDeposit("501", "2026-09-20", 2000));
    expect(await postDisbursementToQb(miss.id)).toBe("waiting");
    expect(await stateOf(miss.id)).toEqual({ qbMatchState: "UNMATCHED", qbTxnId: null });
    expect(await postDisbursementToQb(hit.id)).toBe("matched");
    expect(qbo.posts).toHaveLength(0);
  });

  it("a books closing date before the disbursement lets it be created", async () => {
    await live();
    const e = await completed("TEST-D1", "2026-09-10");
    expect(await postDisbursementToQb(e.id)).toBe("posted");
    expect(qbo.posts).toHaveLength(1);
    expect((await stateOf(e.id)).qbMatchState).toBe("CREATED");
  });

  it("re-reads the books closing date before the create and holds a disbursement it covers as UNBOOKED", async () => {
    await live();
    const e = await completed("TEST-D1", "2026-09-10");
    expect(await postDisbursementToQb(e.id, { close: { ok: true, date: "2026-08-31" } })).toBe("posted");
    const later = await completed("TEST-D2", "2026-09-10", [{ donation: 900 }]);
    qbo.closeDate = "2026-09-30";
    expect(await postDisbursementToQb(later.id, { close: { ok: true, date: "2026-08-31" } })).toBe("queued");
    expect((await stateOf(later.id)).qbMatchState).toBe("UNBOOKED");
    expect(qbo.posts).toHaveLength(1);
  });

  it("a create QuickBooks refuses as a closed period is held as UNBOOKED, never POST_FAILED", async () => {
    await live();
    const e = await completed("TEST-D1", "2026-09-10");
    qbo.mode = "closed";
    expect(await postDisbursementToQb(e.id)).toBe("queued");
    expect((await stateOf(e.id)).qbMatchState).toBe("UNBOOKED");
  });

  it("skips deposits income or finance's exclusions hold, and creates instead", async () => {
    await live();
    const e = await completed("TEST-D1", "2026-09-10");
    qbo.deposits.push(handDeposit("501", "2026-09-10", 1450), handDeposit("502", "2026-09-10", 1450));
    foreignClaims = ["501"];
    await db.donationQbMatchExclusion.create({ data: { orgId, qbTxnId: "502", reason: "payroll", excludedByUserId: 1 } });

    expect(await postDisbursementToQb(e.id)).toBe("posted");
    expect(qbo.posts).toHaveLength(1);
  });
});

describeDb("donation QuickBooks drain: safety", () => {
  it("a crash after QuickBooks accepts is found by key on the next run, even re-dated out of the window, never booked twice", async () => {
    await live();
    const e = await completed("TEST-D1", "2026-09-10");
    qbo.mode = "accept-then-drop";
    expect(await postDisbursementToQb(e.id)).toBe("failed");
    expect((await stateOf(e.id)).qbMatchState).toBe("POST_FAILED");

    qbo.mode = "ok";
    qbo.deposits[0].TxnDate = "2026-11-30";
    expect(await postDisbursementToQb(e.id)).toBe("posted");
    expect(qbo.posts).toHaveLength(1);
    expect(await rowOf(e.id)).toMatchObject({ qbMatchState: "CREATED", qbTxnId: qbo.deposits[0].Id, qbDepositTotalCents: 1450, qbDepositTxnDate: "2026-09-10" });
  });

  it("an attempted record whose own Deposit another record holds goes to finance as AMBIGUOUS, never created", async () => {
    await live();
    const e = await completed("TEST-D1", "2026-09-10");
    qbo.mode = "accept-then-drop";
    await postDisbursementToQb(e.id);
    const own = qbo.deposits[0].Id;
    const other = await held("TEST-Z", "MATCHED");
    await db.disbursementEvent.update({ where: { id: other.id }, data: { qbTxnId: own } });

    qbo.mode = "ok";
    expect(await postDisbursementToQb(e.id)).toBe("queued");
    expect(await rowOf(e.id)).toMatchObject({ qbMatchState: "AMBIGUOUS", qbTxnId: null, qbNote: expect.stringContaining(`${own} is held by disbursement TEST-Z`) });
    expect(qbo.posts).toHaveLength(1);
  });

  it("an attempted record whose lookup read fails goes to finance as NEEDS_FINANCE, never created", async () => {
    await live();
    const e = await completed("TEST-D1", "2026-09-10");
    qbo.mode = "down";
    await postDisbursementToQb(e.id);
    qbo.mode = "ok";
    qbo.createdSinceDown = true;
    expect(await postDisbursementToQb(e.id)).toBe("needs_finance");
    expect(await rowOf(e.id)).toMatchObject({ qbMatchState: "NEEDS_FINANCE", qbNote: expect.stringContaining("may already have booked") });
    expect(qbo.posts).toHaveLength(0);
  });

  it("a post that loses its claim after creating notes the Deposit for finance to void", async () => {
    await live();
    const e = await completed("TEST-D1", "2026-09-10");
    qbo.onCreate = async () => {
      await db.workflowEvent.create({
        data: { orgId, disbursementId: "TEST-D1", entityType: "disbursement", entityId: "TEST-D1", eventType: QB_EVENT.CLAIMED, occurredAt: new Date() },
      });
    };
    expect(await postDisbursementToQb(e.id)).toBe("waiting");
    const created = qbo.deposits[0].Id;
    expect((await rowOf(e.id)).qbNote).toContain(`Deposit ${created} was created by a post that lost its claim`);
    expect(await eventsOf("TEST-D1", QB_EVENT.NOTED)).toHaveLength(1);
  });

  it(`hands the disbursement to finance after ${MAX_POST_ATTEMPTS} failed posts`, async () => {
    await live();
    const e = await completed("TEST-D1", "2026-09-10");
    qbo.mode = "down";
    for (let i = 1; i < MAX_POST_ATTEMPTS; i++) expect(await postDisbursementToQb(e.id)).toBe("failed");
    expect(await postDisbursementToQb(e.id)).toBe("needs_finance");
    expect((await stateOf(e.id)).qbMatchState).toBe("NEEDS_FINANCE");
    expect(await postDisbursementToQb(e.id)).toBe("waiting");
  });

  it("refuses a gift whose owner has no QuickBooks Class, naming the bucket", async () => {
    await live();
    const e = await completed("TEST-D1", "2026-09-10", [{ donation: 1000, ownerId: 2 }]);
    expect(await postDisbursementToQb(e.id)).toBe("failed");
    expect(qbo.posts).toHaveLength(0);
    const [failed] = await eventsOf("TEST-D1", QB_EVENT.FAILED);
    expect(failed.payload).toContain("bucket 2 has no QuickBooks Class");
  });

  it("outside prod sends only TEST- disbursements; prod never sends one", async () => {
    await live();
    const real = await completed("D-REAL", "2026-09-10");
    expect(await postDisbursementToQb(real.id)).toBe("not_sent");
    expect((await stateOf(real.id)).qbMatchState).toBe("NOT_TEST_DATA");

    bind({ prod: true });
    const test = await completed("TEST-D1", "2026-09-10");
    expect(await postDisbursementToQb(test.id)).toBe("not_sent");
    expect((await stateOf(test.id)).qbMatchState).toBe("TEST_DATA_REFUSED");
    expect(qbo.posts).toHaveLength(0);
  });

  it("matches but never creates a disbursement over the per-run cents cap", async () => {
    await live();
    const big = await completed("TEST-BIG", "2026-09-10", [{ donation: MAX_CREATE_CENTS_PER_RUN + 1 }]);
    expect(await postDisbursementToQb(big.id)).toBe("queued");
    expect((await stateOf(big.id)).qbMatchState).toBe("NEEDS_FINANCE");
    expect(qbo.posts).toHaveLength(0);
  });

  it("a fresh claim is left alone; a stale one is taken over", async () => {
    await live();
    const e = await completed("TEST-D1", "2026-09-10");
    await db.disbursementEvent.update({ where: { id: e.id }, data: { qbMatchState: QB_MATCH_STATE.POSTING } });
    const claim = await db.workflowEvent.create({
      data: { orgId, disbursementId: "TEST-D1", entityType: "disbursement", entityId: "TEST-D1", eventType: QB_EVENT.CLAIMED, occurredAt: new Date() },
    });
    expect(await postDisbursementToQb(e.id)).toBe("waiting");

    await db.workflowEvent.update({ where: { id: claim.id }, data: { occurredAt: new Date(Date.now() - STALE_CLAIM_MS - 1000) } });
    expect(await postDisbursementToQb(e.id)).toBe("posted");
    expect(qbo.posts).toHaveLength(1);
  });

  it("answers unbound while QuickBooks is unbound or the guard keeps it off", async () => {
    const e = await completed("TEST-D1", "2026-09-10");
    bind({ qb: "unbound" });
    expect(await runDonationQbPosting(orgId)).toBe("unbound");
    bind({ qb: "off" });
    expect(await runDonationQbPosting(orgId)).toBe("unbound");
    expect(await postDisbursementToQb(e.id)).toBe("unbound");
    expect((await stateOf(e.id)).qbMatchState).toBe("UNMATCHED");
  });
});

describeDb("donation QuickBooks drain: caps", () => {
  it(`stops at ${MAX_CREATES_PER_RUN} creates per run; the rest waits`, async () => {
    await live();
    for (let i = 0; i <= MAX_CREATES_PER_RUN; i++) await completed(`TEST-D${i}`, "2026-09-10", [{ donation: 100 + i }]);

    const counts = await runDonationQbPosting(orgId);

    expect(counts).toMatchObject({ posted: MAX_CREATES_PER_RUN, capped: "count" });
    expect(qbo.posts).toHaveLength(MAX_CREATES_PER_RUN);
  });

  it(`stops at ${MAX_CREATES_PER_DAY} creates per UTC day`, async () => {
    await live();
    await completed("TEST-D1", "2026-09-10");
    await db.workflowEvent.createMany({
      data: Array.from({ length: MAX_CREATES_PER_DAY }, () => ({ orgId, entityType: "disbursement", eventType: QB_EVENT.CREATED, occurredAt: new Date() })),
    });

    expect(await runDonationQbPosting(orgId)).toMatchObject({ posted: 0, capped: "day" });
    expect(qbo.posts).toHaveLength(0);
  });

  it("stops after three failures in a row", async () => {
    await live();
    for (let i = 0; i < 5; i++) await completed(`TEST-D${i}`, "2026-09-10");
    qbo.mode = "down";
    expect(await runDonationQbPosting(orgId)).toMatchObject({ failed: 3, stoppedAfterFailures: true });
  });
});

describeDb("donation QuickBooks drain: drift", () => {
  /** A disbursement the drain created a deposit for, as booked. */
  async function posted(disbursementId = "TEST-D1") {
    await lined();
    const e = await completed(disbursementId, "2026-09-10");
    expect(await postDisbursementToQb(e.id)).toBe("posted");
    const { qbTxnId } = await stateOf(e.id);
    return { e, qbTxnId: qbTxnId! };
  }

  const deposit = (id: string) => qbo.deposits.find((d) => d.Id === id)!;

  const lined = live;

  it("books the created deposit's total and date, and leaves an unchanged deposit alone", async () => {
    const { e, qbTxnId } = await posted();
    expect(await db.disbursementEvent.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({
      qbDepositTotalCents: 1450,
      qbDepositTxnDate: "2026-09-10",
    });

    const counts = await runDonationQbPosting(orgId);

    expect(counts).toMatchObject({ drift: { drifted: 0, failed: 0 } });
    expect(await stateOf(e.id)).toEqual({ qbMatchState: "CREATED", qbTxnId });
    expect(await eventsOf("TEST-D1", QB_EVENT.DRIFT)).toHaveLength(0);
  });

  it("sends a record whose deposit is gone to finance as DRIFT, freeing the deposit id", async () => {
    const { e, qbTxnId } = await posted();
    qbo.deposits = qbo.deposits.filter((d) => d.Id !== qbTxnId);

    expect(await runDonationQbPosting(orgId)).toMatchObject({ drift: { drifted: 1 } });

    expect(await db.disbursementEvent.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({
      qbMatchState: QB_MATCH_STATE.DRIFT,
      qbTxnId: null,
      qbDriftedTxnId: qbTxnId,
      qbDriftCause: QB_DRIFT_CAUSE.MISSING,
      qbDepositTotalCents: 1450,
      qbDepositTxnDate: "2026-09-10",
    });
    const [drift] = await eventsOf("TEST-D1", QB_EVENT.DRIFT);
    expect(JSON.parse(drift.payload!)).toEqual({
      from: "CREATED",
      to: "DRIFT",
      cause: "deposit_missing",
      qbTxnId,
      booked: { totalCents: 1450, txnDate: "2026-09-10" },
      now: null,
    });
    expect(await donationClaimedDepositIds(orgId)).not.toContain(qbTxnId);
  });

  it("sends a record whose deposit total changed to finance as DRIFT, never correcting QuickBooks", async () => {
    const { e, qbTxnId } = await posted();
    deposit(qbTxnId).TotalAmt = 99.99;
    const posts = qbo.posts.length;

    await runDonationQbPosting(orgId);

    expect(await db.disbursementEvent.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({
      qbMatchState: QB_MATCH_STATE.DRIFT,
      qbDriftCause: QB_DRIFT_CAUSE.CHANGED,
    });
    const [drift] = await eventsOf("TEST-D1", QB_EVENT.DRIFT);
    expect(JSON.parse(drift.payload!).now).toEqual({ totalCents: 9999, txnDate: "2026-09-10" });
    expect(qbo.posts).toHaveLength(posts);
    expect(deposit(qbTxnId).TotalAmt).toBe(99.99);
  });

  it("never matches or posts a drifted record again on its own", async () => {
    const { e, qbTxnId } = await posted();
    qbo.deposits = qbo.deposits.filter((d) => d.Id !== qbTxnId);
    await runDonationQbPosting(orgId);
    qbo.deposits.push(handDeposit("777", "2026-09-10", 1450));
    const posts = qbo.posts.length;

    await runDonationQbPosting(orgId);
    expect(await postDisbursementToQb(e.id)).toBe("waiting");

    expect(await stateOf(e.id)).toEqual({ qbMatchState: "DRIFT", qbTxnId: null });
    expect(qbo.posts).toHaveLength(posts);
    expect(await eventsOf("TEST-D1", QB_EVENT.DRIFT)).toHaveLength(1);
  });

  it("a matched deposit's date is the one it had when matched, so a change before the first check is caught", async () => {
    await lined();
    const e = await completed("TEST-D1", "2026-09-10");
    qbo.deposits.push(handDeposit("501", "2026-09-12", 1450));
    expect(await postDisbursementToQb(e.id)).toBe("matched");
    expect((await db.disbursementEvent.findUniqueOrThrow({ where: { id: e.id } })).qbDepositTxnDate).toBe("2026-09-12");

    deposit("501").TxnDate = "2026-09-13";
    await runDonationQbPosting(orgId);
    expect((await stateOf(e.id)).qbMatchState).toBe("DRIFT");
  });

  it("changes nothing when the QuickBooks read fails", async () => {
    const { e, qbTxnId } = await posted();
    qbo.mode = "down";
    expect(await runDonationQbPosting(orgId)).toMatchObject({ closeDateRead: false, drift: { checked: 0, failed: 1 }, sweep: { failed: true } });
    expect(await stateOf(e.id)).toEqual({ qbMatchState: "CREATED", qbTxnId });
  });

  it(`reads at most ${MAX_DRIFT_CHECKS_PER_RUN} deposits per run`, async () => {
    await lined();
    for (let i = 0; i < MAX_DRIFT_CHECKS_PER_RUN + 2; i++) {
      const e = await completed(`TEST-D${i}`, "2026-09-10", [{ donation: 100 + i }]);
      expect(await postDisbursementToQb(e.id)).toBe("posted");
    }
    const counts = await runDonationQbPosting(orgId);
    expect(counts).toMatchObject({ drift: { checked: MAX_DRIFT_CHECKS_PER_RUN } });
  });
});

const route = (path: string, body?: unknown) =>
  new Request(`http://test/api/donations${path}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

const resolve = (disbursementId: string, body: unknown) =>
  disbursements.qbResolve({ req: route(`/disbursement-events/${disbursementId}/qb-resolve`, body), params: { disbursementId } });

const candidatesOf = async (disbursementId: string) =>
  (await disbursements.qbCandidates({ req: route(`/disbursement-events/${disbursementId}/qb-candidates`), params: { disbursementId } })).DonationQbCandidateView;

/** A completed disbursement the drain left in `state`. */
async function held(disbursementId: string, state: string, date = "2026-09-10") {
  const e = await completed(disbursementId, date);
  await db.disbursementEvent.update({ where: { id: e.id }, data: { qbMatchState: state } });
  return e;
}

describeDb("donation QuickBooks finance queue", () => {
  it("lists only the requested match states and rejects an unknown one", async () => {
    await held("TEST-A", "AMBIGUOUS");
    await held("TEST-B", "MATCHED");
    const out = await disbursements.listEvents({ req: route(`/disbursement-events?qbState=AMBIGUOUS,NEEDS_FINANCE`), params: {} });
    expect((out.DisbursementEvent as { disbursementId: string }[]).map((r) => r.disbursementId)).toEqual(["TEST-A"]);
    await expect(disbursements.listEvents({ req: route(`/disbursement-events?qbState=NOPE`), params: {} })).rejects.toMatchObject({ status: 400 });
  });

  it("offers unclaimed, unexcluded deposits in the bank account within the window, with no key leaking into the shape", async () => {
    await held("TEST-A", "AMBIGUOUS");
    qbo.deposits.push(
      { ...handDeposit("501", "2026-09-12", 1450), PrivateNote: "hand note" },
      handDeposit("502", "2026-09-12", 1450, "99"),
      handDeposit("503", "2026-08-01", 1450),
      handDeposit("504", "2026-09-11", 1450),
      handDeposit("505", "2026-09-11", 1450),
    );
    foreignClaims = ["504"];
    await db.donationQbMatchExclusion.create({ data: { orgId, qbTxnId: "505", reason: "payroll", excludedByUserId: 1 } });

    expect(await candidatesOf("TEST-A")).toEqual([{ id: "501", type: "Deposit", date: "2026-09-12", amountCents: 1450, memo: "hand note" }]);
  });

  it("answers 503 for candidates while QuickBooks is off", async () => {
    await held("TEST-A", "AMBIGUOUS");
    bind({ qb: "off" });
    await expect(candidatesOf("TEST-A")).rejects.toMatchObject({ status: 503 });
  });

  it("matches a picked hand deposit as MATCHED and records the finance actor", async () => {
    const e = await held("TEST-A", "AMBIGUOUS");
    qbo.deposits.push(handDeposit("501", "2026-09-12", 1450), handDeposit("502", "2026-09-12", 1450));

    const out = await resolve("TEST-A", { action: "match", qbTxnId: "502" });

    expect(out.DisbursementEvent).toMatchObject({ qbMatchState: "MATCHED", qbTxnId: "502" });
    expect(await stateOf(e.id)).toEqual({ qbMatchState: "MATCHED", qbTxnId: "502" });
    const [matched] = await eventsOf("TEST-A", QB_MATCHED_EVENT);
    expect(matched.actorUserId).toBe(1);
    await expect(resolve("TEST-A", { action: "match", qbTxnId: "501" })).rejects.toMatchObject({ status: 409 });
  });

  it("takes a deposit carrying this disbursement's own key as CREATED, with no match event", async () => {
    const e = await held("TEST-A", "AMBIGUOUS");
    const key = qbKey("donation", `${orgId}:TEST-A`);
    qbo.deposits.push({ ...handDeposit("601", "2026-09-10", 1450), PrivateNote: `Benevity [checkin:${key}]` });

    await resolve("TEST-A", { action: "match", qbTxnId: "601" });

    expect(await stateOf(e.id)).toEqual({ qbMatchState: "CREATED", qbTxnId: "601" });
    expect(await eventsOf("TEST-A", QB_MATCHED_EVENT)).toHaveLength(0);
  });

  it("needs a reason for a deposit whose amount differs, and refuses a deposit that is not a free candidate", async () => {
    const e = await held("TEST-A", "BEFORE_LINE");
    qbo.deposits.push(handDeposit("501", "2026-09-12", 1400), handDeposit("502", "2026-09-12", 1450));
    foreignClaims = ["502"];

    await expect(resolve("TEST-A", { action: "match", qbTxnId: "501" })).rejects.toMatchObject({ status: 400 });
    await expect(resolve("TEST-A", { action: "match", qbTxnId: "502" })).rejects.toMatchObject({ status: 422 });
    expect((await stateOf(e.id)).qbMatchState).toBe("BEFORE_LINE");

    await resolve("TEST-A", { action: "match", qbTxnId: "501", reason: "Benevity short-paid by $0.50" });
    expect(await stateOf(e.id)).toEqual({ qbMatchState: "MATCHED", qbTxnId: "501" });
    const [manual] = await eventsOf("TEST-A", QB_EVENT.STATE);
    expect(JSON.parse(manual.payload ?? "{}")).toMatchObject({ manual: true, reason: "Benevity short-paid by $0.50" });
  });

  it("refuses a deposit created for another record, and retry of an unbooked record", async () => {
    const e = await held("TEST-A", "BEFORE_LINE");
    const other = qbKey("donation", `${orgId}:TEST-Z`);
    qbo.deposits.push({ ...handDeposit("701", "2026-09-10", 1450), PrivateNote: `Benevity [checkin:${other}]` });

    await expect(resolve("TEST-A", { action: "match", qbTxnId: "701" })).rejects.toMatchObject({ status: 409 });
    await expect(resolve("TEST-A", { action: "retry" })).rejects.toMatchObject({ status: 409 });
    expect(await stateOf(e.id)).toEqual({ qbMatchState: "BEFORE_LINE", qbTxnId: null });
    expect(await eventsOf("TEST-A", QB_MATCHED_EVENT)).toHaveLength(0);
  });

  it("refuses to match or retry a disbursement that is not held", async () => {
    await held("TEST-A", "MATCHED");
    qbo.deposits.push(handDeposit("501", "2026-09-12", 1450));
    await expect(resolve("TEST-A", { action: "match", qbTxnId: "501" })).rejects.toMatchObject({ status: 409 });
    await expect(resolve("TEST-A", { action: "retry" })).rejects.toMatchObject({ status: 409 });
  });

  it("retry while QuickBooks posting is off only re-arms the record: nothing reaches QuickBooks", async () => {
    await live();
    await held("TEST-A", "NEEDS_FINANCE");
    bind({ qb: "off" });

    const out = await resolve("TEST-A", { action: "retry" });

    expect(out.DisbursementEvent).toMatchObject({ qbMatchState: "UNMATCHED", qbTxnId: null });
    expect(qbo.posts).toHaveLength(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(await eventsOf("TEST-A", QB_EVENT.RETRIED)).toHaveLength(1);
    expect(await eventsOf("TEST-A", QB_EVENT.CLAIMED)).toHaveLength(0);
  });

  it("retry with QuickBooks on resets the attempt count and posts once through the drain", async () => {
    await live();
    const e = await completed("TEST-A", "2026-09-10");
    qbo.mode = "down";
    for (let i = 0; i < MAX_POST_ATTEMPTS; i++) await postDisbursementToQb(e.id);
    expect((await stateOf(e.id)).qbMatchState).toBe("NEEDS_FINANCE");

    qbo.mode = "ok";
    await resolve("TEST-A", { action: "retry" });

    expect(qbo.posts).toHaveLength(1);
    expect((await stateOf(e.id)).qbMatchState).toBe("CREATED");
  });

  it("dismiss needs a reason, settles the record with an audit event, and the drain never posts it again", async () => {
    await live();
    const e = await held("TEST-A", "NEEDS_FINANCE");
    qbo.deposits.push(handDeposit("501", "2026-09-10", 1450));

    await expect(resolve("TEST-A", { action: "dismiss", reason: " " })).rejects.toMatchObject({ status: 400 });
    const out = await resolve("TEST-A", { action: "dismiss", reason: "Deposit deleted in QuickBooks; booked by journal entry" });

    expect(out.DisbursementEvent).toMatchObject({ qbMatchState: "DISMISSED", qbTxnId: null });
    const [event] = await eventsOf("TEST-A", QB_EVENT.STATE);
    expect(event.actorUserId).toBe(1);
    expect(JSON.parse(event.payload ?? "{}")).toMatchObject({ from: "NEEDS_FINANCE", to: "DISMISSED", reason: "Deposit deleted in QuickBooks; booked by journal entry" });

    expect(await postDisbursementToQb(e.id)).toBe("waiting");
    await runDonationQbPosting(orgId);
    expect(qbo.posts).toHaveLength(0);
    expect(await stateOf(e.id)).toEqual({ qbMatchState: "DISMISSED", qbTxnId: null });
    await expect(resolve("TEST-A", { action: "retry" })).rejects.toMatchObject({ status: 409 });
    await expect(resolve("TEST-A", { action: "dismiss", reason: "again" })).rejects.toMatchObject({ status: 409 });
  });

  it("lists DRIFT, re-matches its changed deposit with the deposit as it is now, and closes the drift out", async () => {
    const e = await held("TEST-A", "DRIFT");
    await db.disbursementEvent.update({
      where: { id: e.id },
      data: { qbDriftedTxnId: "501", qbDriftCause: QB_DRIFT_CAUSE.CHANGED, qbDepositTotalCents: 1450, qbDepositTxnDate: "2026-09-10" },
    });
    qbo.deposits.push(handDeposit("501", "2026-09-11", 1500));

    const queue = await disbursements.listEvents({ req: route(`/disbursement-events?qbState=DRIFT`), params: {} });
    expect((queue.DisbursementEvent as { disbursementId: string }[]).map((r) => r.disbursementId)).toEqual(["TEST-A"]);
    expect(((await candidatesOf("TEST-A")) as { id: string }[]).map((c) => c.id)).toEqual(["501"]);
    await expect(resolve("TEST-A", { action: "retry" })).rejects.toMatchObject({ status: 409 });

    await resolve("TEST-A", { action: "match", qbTxnId: "501", reason: "Benevity corrected the batch" });

    expect(await db.disbursementEvent.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({
      qbMatchState: "MATCHED", qbTxnId: "501", qbDepositTotalCents: 1500, qbDepositTxnDate: "2026-09-11",
      qbDriftedTxnId: null, qbDriftCause: null,
    });
  });

  it("dismissing a DRIFT record closes the drift out", async () => {
    const e = await held("TEST-A", "DRIFT");
    await db.disbursementEvent.update({ where: { id: e.id }, data: { qbDriftedTxnId: "501", qbDriftCause: QB_DRIFT_CAUSE.MISSING } });

    await resolve("TEST-A", { action: "dismiss", reason: "Deposit deleted; booked by journal entry" });

    expect(await db.disbursementEvent.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({
      qbMatchState: "DISMISSED", qbTxnId: null, qbDriftedTxnId: null, qbDriftCause: null,
    });
  });

  it("refuses to exclude a deposit a disbursement already holds", async () => {
    const e = await held("TEST-A", "MATCHED");
    await db.disbursementEvent.update({ where: { id: e.id }, data: { qbTxnId: "501" } });
    const req = route("/qb-exclusions", { qbTxnId: "501", reason: "not ours" });
    await expect(disbursements.createExclusion({ req, params: {} })).rejects.toMatchObject({ status: 409 });
    expect(await db.donationQbMatchExclusion.count()).toBe(0);
  });
});

describeDb("donation QuickBooks switch-on", () => {
  it("the drain's first connected run stamps switch-on, and later runs never move it", async () => {
    bind({ qb: "off" });
    await runDonationQbPosting(orgId);
    expect(await qbPostingOnAt(orgId)).toBeNull();

    bind();
    await runDonationQbPosting(orgId);
    const first = await qbPostingOnAt(orgId);
    expect(first).not.toBeNull();
    await runDonationQbPosting(orgId, new Date(Date.now() + 86_400_000));
    expect(await qbPostingOnAt(orgId)).toEqual(first);
    expect(await db.workflowEvent.count({ where: { orgId, eventType: QB_EVENT.SWITCHED_ON } })).toBe(1);
  });

  it("a record uploaded before the first connected run stays in the open period", async () => {
    qbo.closeDate = "2026-08-31";
    const e = await completed("TEST-D1", "2026-09-10");
    await db.disbursementEvent.update({ where: { id: e.id }, data: { createdAt: new Date(Date.now() - 1000) } });
    await runDonationQbPosting(orgId);
    expect((await stateOf(e.id)).qbMatchState).toBe("UNBOOKED");
    expect(qbo.posts).toHaveLength(0);
  });
});

describe("qbGate", () => {
  const on = new Date("2026-10-01T12:00:00Z");
  const after = new Date("2026-10-02T00:00:00Z");
  const before = new Date("2026-09-30T00:00:00Z");

  it("gates on the closing date, and creates only what was uploaded after switch-on or what finance books", () => {
    expect(qbGate("2026-09-10", { ok: true, date: "2026-08-31" }, on, after, false)).toEqual({ closedThrough: "2026-08-31", mayCreate: true });
    expect(qbGate("2026-09-10", { ok: true, date: "2026-08-31" }, on, before, false)).toEqual({ closedThrough: "2026-08-31", mayCreate: false });
    expect(qbGate("2026-09-10", { ok: true, date: "2026-08-31" }, null, before, true)).toEqual({ closedThrough: "2026-08-31", mayCreate: true });
  });

  it("with no closing date, closes everything before switch-on; with neither, creates nothing", () => {
    expect(qbGate("2026-09-10", { ok: true, date: null }, on, after, false)).toEqual({ closedThrough: "2026-09-30", mayCreate: true });
    expect(qbGate("2026-09-10", { ok: true, date: null }, null, after, true)).toEqual({ closedThrough: "2026-09-09", mayCreate: false });
  });

  it("a failed read creates nothing", () => {
    expect(qbGate("2026-09-10", { ok: false, error: "down" }, on, after, true)).toEqual({ closedThrough: "2026-09-09", mayCreate: false });
  });
});

describeDb("donation QuickBooks finance queue: book it", () => {
  it("books an UNBOOKED record, matching first, with the finance actor on the audit", async () => {
    qbo.closeDate = "2026-08-31";
    await db.donationOrgSettings.create({ data: { orgId, qbPostingOnAt: new Date(Date.now() + 60_000) } });
    const e = await completed("TEST-A", "2026-09-10");
    expect(await postDisbursementToQb(e.id)).toBe("queued");
    expect((await stateOf(e.id)).qbMatchState).toBe("UNBOOKED");

    const out = await resolve("TEST-A", { action: "book" });

    expect(out.DisbursementEvent).toMatchObject({ qbMatchState: "CREATED" });
    expect(qbo.posts).toHaveLength(1);
    const [asked] = await eventsOf("TEST-A", QB_EVENT.BOOK_REQUESTED);
    expect(asked.actorUserId).toBe(1);
  });

  it("books a record still parked as BEFORE_LINE", async () => {
    qbo.closeDate = "2026-08-31";
    const e = await held("TEST-A", "BEFORE_LINE");
    await resolve("TEST-A", { action: "book" });
    expect((await stateOf(e.id)).qbMatchState).toBe("CREATED");
  });

  it("books a record the drain held as NEEDS_FINANCE for the per-run cents cap", async () => {
    await live();
    const big = await completed("TEST-BIG", "2026-09-10", [{ donation: MAX_CREATE_CENTS_PER_RUN + 1 }]);
    await runDonationQbPosting(orgId);
    expect((await stateOf(big.id)).qbMatchState).toBe("NEEDS_FINANCE");
    await resolve("TEST-BIG", { action: "book" });
    expect((await stateOf(big.id)).qbMatchState).toBe("CREATED");
  });

  it("a book QuickBooks fails answers 503 and leaves the record bookable, so a second book creates it once", async () => {
    qbo.closeDate = "2026-08-31";
    const e = await held("TEST-A", "UNBOOKED");
    qbo.mode = "accept-then-drop";
    await expect(resolve("TEST-A", { action: "book" })).rejects.toMatchObject({ status: 503 });
    expect((await stateOf(e.id)).qbMatchState).toBe("POST_FAILED");

    qbo.mode = "ok";
    await resolve("TEST-A", { action: "book" });
    expect(await stateOf(e.id)).toEqual({ qbMatchState: "CREATED", qbTxnId: qbo.deposits[0].Id });
    expect(qbo.posts).toHaveLength(1);
  });

  it("a refused book keeps the record's note; a booked one answers it", async () => {
    qbo.closeDate = "2026-09-30";
    const e = await held("TEST-A", "UNBOOKED");
    await db.disbursementEvent.update({ where: { id: e.id }, data: { qbNote: "check this one" } });
    await expect(resolve("TEST-A", { action: "book" })).rejects.toMatchObject({ status: 409 });
    expect((await rowOf(e.id)).qbNote).toBe("check this one");

    qbo.closeDate = "2026-08-31";
    await resolve("TEST-A", { action: "book" });
    expect(await rowOf(e.id)).toMatchObject({ qbMatchState: "CREATED", qbNote: null });
  });

  it("refuses a record in closed books, which stays UNBOOKED for a skip", async () => {
    qbo.closeDate = "2026-09-30";
    const e = await held("TEST-A", "UNBOOKED");
    await expect(resolve("TEST-A", { action: "book" })).rejects.toMatchObject({ status: 409 });
    expect((await stateOf(e.id)).qbMatchState).toBe("UNBOOKED");
    expect(qbo.posts).toHaveLength(0);
  });

  it("refuses with no closing date and no switch-on, and answers 503 when the date cannot be read", async () => {
    await held("TEST-A", "UNBOOKED");
    await expect(resolve("TEST-A", { action: "book" })).rejects.toMatchObject({ status: 409 });
    qbo.prefsDown = true;
    await expect(resolve("TEST-A", { action: "book" })).rejects.toMatchObject({ status: 503 });
    expect(qbo.posts).toHaveLength(0);
  });

  it("never books a DRIFT or AMBIGUOUS record", async () => {
    qbo.closeDate = "2026-08-31";
    await held("TEST-A", "DRIFT");
    await held("TEST-B", "AMBIGUOUS");
    await expect(resolve("TEST-A", { action: "book" })).rejects.toMatchObject({ status: 409 });
    await expect(resolve("TEST-B", { action: "book" })).rejects.toMatchObject({ status: 409 });
    expect(qbo.posts).toHaveLength(0);
  });

  it("the drain never posts an UNBOOKED record on its own", async () => {
    await live();
    const e = await held("TEST-A", "UNBOOKED");
    await runDonationQbPosting(orgId);
    expect((await stateOf(e.id)).qbMatchState).toBe("UNBOOKED");
    expect(qbo.posts).toHaveLength(0);
  });
});

describeDb("donation QuickBooks finance queue: attempted records look first", () => {
  /** A record whose create landed in QuickBooks while the post failed. */
  async function landed(disbursementId = "TEST-A") {
    await live();
    const e = await completed(disbursementId, "2026-09-10");
    qbo.mode = "accept-then-drop";
    expect(await postDisbursementToQb(e.id)).toBe("failed");
    qbo.mode = "ok";
    return { e, own: qbo.deposits[0].Id };
  }

  it("a match links the app's own Deposit instead and says so in the row", async () => {
    const { e, own } = await landed();
    qbo.deposits.push(handDeposit("501", "2026-09-12", 1450));
    const out = await resolve("TEST-A", { action: "match", qbTxnId: "501" });
    expect(out.DisbursementEvent).toMatchObject({ qbMatchState: "CREATED", qbTxnId: own });
    expect(await stateOf(e.id)).toEqual({ qbMatchState: "CREATED", qbTxnId: own });
    expect(await eventsOf("TEST-A", QB_MATCHED_EVENT)).toHaveLength(0);
  });

  it("a dismiss links the app's own Deposit instead", async () => {
    const { e, own } = await landed();
    await resolve("TEST-A", { action: "dismiss", reason: "booked by hand" });
    expect(await stateOf(e.id)).toEqual({ qbMatchState: "CREATED", qbTxnId: own });
  });

  it("refuses when another record holds the app's Deposit, and answers 503 when the read fails", async () => {
    const { e, own } = await landed();
    const other = await held("TEST-Z", "MATCHED");
    await db.disbursementEvent.update({ where: { id: other.id }, data: { qbTxnId: own } });
    await expect(resolve("TEST-A", { action: "dismiss", reason: "x" })).rejects.toMatchObject({ status: 409 });
    qbo.createdSinceDown = true;
    await expect(resolve("TEST-A", { action: "dismiss", reason: "x" })).rejects.toMatchObject({ status: 503 });
    expect((await stateOf(e.id)).qbMatchState).toBe("POST_FAILED");
  });

  it("refuses to link when the record left its held state during the lookup", async () => {
    const { e } = await landed();
    qbo.onCreatedSince = async () => {
      await db.disbursementEvent.update({ where: { id: e.id }, data: { qbMatchState: QB_MATCH_STATE.DISMISSED } });
    };
    await expect(resolve("TEST-A", { action: "dismiss", reason: "booked by hand" })).rejects.toMatchObject({ status: 409 });
    expect(await stateOf(e.id)).toEqual({ qbMatchState: "DISMISSED", qbTxnId: null });
  });

  it("goes ahead when nothing carries the key", async () => {
    await live();
    const e = await completed("TEST-A", "2026-09-10");
    qbo.mode = "down";
    await postDisbursementToQb(e.id);
    qbo.mode = "ok";
    await resolve("TEST-A", { action: "dismiss", reason: "booked by journal entry" });
    expect((await stateOf(e.id)).qbMatchState).toBe("DISMISSED");
  });
});

describeDb("donation QuickBooks orphan sweep", () => {
  it("notes an app Deposit its record does not hold, lists the record for finance, and finance clears the note", async () => {
    await live();
    const e = await completed("TEST-A", "2026-09-10");
    expect(await postDisbursementToQb(e.id)).toBe("posted");
    const { qbTxnId } = await stateOf(e.id);
    const stray = { ...qbo.deposits[0], Id: "8888", TxnDate: "2026-12-01" };
    qbo.deposits.push(stray);
    qbo.createTimes.set("8888", new Date());

    const counts = await runDonationQbPosting(orgId);

    expect(counts).toMatchObject({ sweep: { flagged: 1, full: false } });
    expect(await rowOf(e.id)).toMatchObject({ qbMatchState: "CREATED", qbTxnId, qbNote: expect.stringContaining("Deposit 8888") });
    await runDonationQbPosting(orgId);
    expect(await eventsOf("TEST-A", QB_EVENT.NOTED)).toHaveLength(1);

    const list = (qs: string) => disbursements.listEvents({ req: route(`/disbursement-events?${qs}`), params: {} });
    const ids = (out: Awaited<ReturnType<typeof list>>) => (out.DisbursementEvent as { disbursementId: string }[]).map((r) => r.disbursementId);
    expect(ids(await list("qbState=AMBIGUOUS"))).toEqual([]);
    expect(ids(await list("qbState=AMBIGUOUS&noted=1"))).toEqual(["TEST-A"]);

    await expect(resolve("TEST-A", { action: "clear", reason: " " })).rejects.toMatchObject({ status: 400 });
    await resolve("TEST-A", { action: "clear", reason: "voided 8888 in QuickBooks" });
    expect(await rowOf(e.id)).toMatchObject({ qbMatchState: "CREATED", qbTxnId, qbNote: null });
    const [cleared] = await eventsOf("TEST-A", QB_EVENT.NOTE_CLEARED);
    expect(cleared.actorUserId).toBe(1);
    await expect(resolve("TEST-A", { action: "clear", reason: "again" })).rejects.toMatchObject({ status: 409 });
  });

  it("a record the drain links to its own Deposit in the same run is never reported as a stray", async () => {
    await live();
    const e = await completed("TEST-A", "2026-09-10");
    qbo.mode = "accept-then-drop";
    expect(await postDisbursementToQb(e.id)).toBe("failed");
    qbo.mode = "ok";

    expect(await runDonationQbPosting(orgId)).toMatchObject({ posted: 1, sweep: { flagged: 0 } });
    expect(await rowOf(e.id)).toMatchObject({ qbMatchState: "CREATED", qbTxnId: qbo.deposits[0].Id, qbNote: null });
    expect(await eventsOf("TEST-A", QB_EVENT.NOTED)).toHaveLength(0);
  });

  it("linking a Deposit answers a note the record already carried", async () => {
    await live();
    const e = await completed("TEST-A", "2026-09-10");
    qbo.mode = "accept-then-drop";
    await postDisbursementToQb(e.id);
    qbo.mode = "ok";
    await db.disbursementEvent.update({ where: { id: e.id }, data: { qbNote: `QuickBooks Deposit ${qbo.deposits[0].Id} carries this disbursement's key but is not linked to it; void it or link it` } });

    expect(await postDisbursementToQb(e.id)).toBe("posted");
    expect(await rowOf(e.id)).toMatchObject({ qbMatchState: "CREATED", qbNote: null });
  });

  it("alerts finance when the read fills a page, since some Deposits went unchecked", async () => {
    await live();
    const e = await completed("TEST-A", "2026-09-10");
    await postDisbursementToQb(e.id);
    const attempted = (await rowOf(e.id)).qbCreateAttemptedAt;
    for (let i = 0; i < 1000; i++) {
      qbo.deposits.push(handDeposit(`h${i}`, "2026-10-01", 100 + i, "99"));
      qbo.createTimes.set(`h${i}`, new Date());
    }

    expect(await runDonationQbPosting(orgId)).toMatchObject({ sweep: { full: true } });
    expect(sweepAlerts).toEqual([{ orgId, since: attempted }]);
  });

  it("reads nothing while no record was attempted in the window, and leaves linked Deposits alone", async () => {
    await live();
    expect(await runDonationQbPosting(orgId)).toMatchObject({ sweep: { entries: 0, flagged: 0 } });
    const e = await completed("TEST-A", "2026-09-10");
    await postDisbursementToQb(e.id);
    expect(await runDonationQbPosting(orgId)).toMatchObject({ sweep: { entries: 1, flagged: 0 } });
    expect((await rowOf(e.id)).qbNote).toBeNull();
  });
});
