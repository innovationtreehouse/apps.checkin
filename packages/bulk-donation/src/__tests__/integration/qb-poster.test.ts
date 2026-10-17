/**
 * The QuickBooks drain: completed disbursements post as bank Deposits through the real
 * QuickBooksClient over an in-memory QBO company. Match before create; the key makes a retry safe.
 */
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { QuickBooksClient, qbKey, type QboDeposit } from "@checkin/quickbooks";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { configureBulkDonation } from "../../runtime";
import type { OwnerInfo } from "../../contract";
import { makeFile, makeTransaction, TEST_ORG_ID } from "../helpers/factories";
import { QB_MATCHED_EVENT, QB_MATCH_STATE, benevityTakeoverLine, recordQbMatched } from "../../lib/qb-match";
import {
  MAX_CREATES_PER_DAY, MAX_CREATES_PER_RUN, MAX_CREATE_CENTS_PER_RUN, MAX_DRIFT_CHECKS_PER_RUN, MAX_POST_ATTEMPTS, QB_DRIFT_CAUSE,
  QB_EVENT, STALE_CLAIM_MS,
  donationClaimedDepositIds, postDisbursementToQb, runDonationQbPosting,
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

/** Windowed Deposit reads, Account lookups by name, and Deposit creates. */
class FakeQbo {
  deposits: QboDeposit[] = [];
  posts: { key: string; body: PostedDeposit }[] = [];
  mode: "ok" | "down" | "accept-then-drop" = "ok";
  private nextId = 7000;

  handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { intuit_tid: "tid" } });
    if (this.mode === "down") return json({ Fault: { Error: [{ code: "3100" }] } }, 503);
    if ((init?.method ?? "GET") === "GET") {
      const query = url.searchParams.get("query") ?? "";
      const account = /FROM Account WHERE FullyQualifiedName = '([^']+)'/.exec(query);
      if (account) {
        const Id = ACCOUNTS[account[1]];
        return json({ QueryResponse: Id ? { Account: [{ Id, Name: account[1], FullyQualifiedName: account[1] }] } : {} });
      }
      const m = /FROM Deposit WHERE TxnDate >= '([\d-]+)' AND TxnDate <= '([\d-]+)'/.exec(query);
      if (!m) throw new Error(`unexpected query ${query}`);
      const list = this.deposits.filter((d) => d.TxnDate >= m[1] && d.TxnDate <= m[2]);
      return json({ QueryResponse: list.length ? { Deposit: list } : {} });
    }
    if (!url.pathname.endsWith("/deposit")) throw new Error(`unexpected write ${url.pathname}`);
    const body = JSON.parse(String(init?.body)) as PostedDeposit;
    this.posts.push({ key: url.searchParams.get("requestid") ?? "", body });
    const Id = String(this.nextId++);
    const TotalAmt = body.Line.reduce((s, l) => s + Math.round(l.Amount * 100), 0) / 100;
    this.deposits.push({ Id, TxnDate: body.TxnDate, TotalAmt, DepositToAccountRef: body.DepositToAccountRef, PrivateNote: body.PrivateNote });
    if (this.mode === "accept-then-drop") throw new Error("socket hang up");
    return json({ Deposit: { Id } });
  };
}

let qbo: FakeQbo;
let foreignClaims: string[];

function bind(opts: { prod?: boolean; qb?: "on" | "off" | "unbound" } = {}) {
  const client = new QuickBooksClient({ current: async () => "tok" }, { env: "sandbox", realmId: "123" });
  configureBulkDonation({
    auth: { getPrincipal: async () => ({ id: 1, name: "testfinance" }) },
    org: async () => ({ id: orgId, name: "Test Org" }),
    owners: { list: async () => OWNERS },
    qb: opts.qb === "unbound" ? undefined : { client: async () => (opts.qb === "off" ? null : client), bankAccountId: BANK, prod: opts.prod ?? false },
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

/** A disbursement finance booked by hand on `day`: sets the takeover line there. */
async function handMatched(day: string) {
  const e = await completed(`TEST-HAND-${day}`, day);
  const qbTxnId = `9${day.replaceAll("-", "")}`;
  await db.disbursementEvent.update({ where: { id: e.id }, data: { qbMatchState: QB_MATCH_STATE.MATCHED, qbTxnId } });
  await recordQbMatched(db, orgId, { disbursementId: e.disbursementId, disbursementDate: day, qbTxnId }, {});
}

const handDeposit = (Id: string, TxnDate: string, cents: number, account = BANK): QboDeposit => ({
  Id, TxnDate, TotalAmt: cents / 100, DepositToAccountRef: { value: account },
});

async function stateOf(id: number) {
  return db.disbursementEvent.findUniqueOrThrow({ where: { id }, select: { qbMatchState: true, qbTxnId: true } });
}

function eventsOf(disbursementId: string, eventType: string) {
  return db.workflowEvent.findMany({ where: { orgId, entityId: disbursementId, eventType } });
}

beforeEach(async () => {
  await db.workflowEvent.deleteMany({});
  await db.disbursementEvent.deleteMany({});
  await db.transaction.deleteMany({});
  await db.uploadedFile.deleteMany({});
  await db.donationQbMatchExclusion.deleteMany({});
  qbo = new FakeQbo();
  foreignClaims = [];
  vi.stubGlobal("fetch", vi.fn(qbo.handle));
  bind();
});

afterEach(() => vi.unstubAllGlobals());

describeDb("donation QuickBooks drain: outcomes", () => {
  it("creates nothing while the stream has no takeover line", async () => {
    const e = await completed("TEST-D1", "2026-09-10");
    expect(await postDisbursementToQb(e.id)).toBe("waiting");
    expect(qbo.posts).toHaveLength(0);
    expect(await stateOf(e.id)).toEqual({ qbMatchState: "UNMATCHED", qbTxnId: null });
  });

  it("after the line, books one bank Deposit: gifts and matches in, fees out, each line with its owner's Class", async () => {
    await handMatched("2026-09-01");
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
    // A created entry never moves the line.
    expect(await eventsOf("TEST-D1", QB_MATCHED_EVENT)).toHaveLength(0);
    expect(await benevityTakeoverLine(db, orgId)).toBe("2026-09-01");
    expect(await donationClaimedDepositIds(orgId)).toContain(after.qbTxnId);
  });

  it("matches a hand-booked deposit of the same net in the bank account, writes QB_MATCHED, and moves the line", async () => {
    await handMatched("2026-09-01");
    const e = await completed("TEST-D1", "2026-09-10");
    qbo.deposits.push(handDeposit("501", "2026-09-12", 1450), handDeposit("502", "2026-09-12", 1450, "99"));

    expect(await postDisbursementToQb(e.id)).toBe("matched");

    expect(qbo.posts).toHaveLength(0);
    expect(await stateOf(e.id)).toEqual({ qbMatchState: "MATCHED", qbTxnId: "501" });
    expect(await eventsOf("TEST-D1", QB_MATCHED_EVENT)).toHaveLength(1);
    expect(await benevityTakeoverLine(db, orgId)).toBe("2026-09-10");
  });

  it("sends two equal candidates to finance, never a guess", async () => {
    const e = await completed("TEST-D1", "2026-09-10");
    qbo.deposits.push(handDeposit("501", "2026-09-09", 1450), handDeposit("502", "2026-09-11", 1450));
    expect(await postDisbursementToQb(e.id)).toBe("queued");
    expect((await stateOf(e.id)).qbMatchState).toBe("AMBIGUOUS");
  });

  it("leaves an unmatched disbursement on or before the line for finance", async () => {
    await handMatched("2026-09-20");
    const e = await completed("TEST-D1", "2026-09-10");
    expect(await postDisbursementToQb(e.id)).toBe("queued");
    expect((await stateOf(e.id)).qbMatchState).toBe("BEFORE_LINE");
    expect(qbo.posts).toHaveLength(0);
  });

  it("skips deposits income or finance's exclusions hold, and creates instead", async () => {
    await handMatched("2026-09-01");
    const e = await completed("TEST-D1", "2026-09-10");
    qbo.deposits.push(handDeposit("501", "2026-09-10", 1450), handDeposit("502", "2026-09-10", 1450));
    foreignClaims = ["501"];
    await db.donationQbMatchExclusion.create({ data: { orgId, qbTxnId: "502", reason: "payroll", excludedByUserId: 1 } });

    expect(await postDisbursementToQb(e.id)).toBe("posted");
    expect(qbo.posts).toHaveLength(1);
  });
});

describeDb("donation QuickBooks drain: safety", () => {
  it("a crash after QuickBooks accepts is found by key on the next run, never booked twice", async () => {
    await handMatched("2026-09-01");
    const e = await completed("TEST-D1", "2026-09-10");
    qbo.mode = "accept-then-drop";
    expect(await postDisbursementToQb(e.id)).toBe("failed");
    expect((await stateOf(e.id)).qbMatchState).toBe("POST_FAILED");

    qbo.mode = "ok";
    expect(await postDisbursementToQb(e.id)).toBe("posted");
    expect(qbo.posts).toHaveLength(1);
    expect(await stateOf(e.id)).toEqual({ qbMatchState: "CREATED", qbTxnId: qbo.deposits[0].Id });
  });

  it(`hands the disbursement to finance after ${MAX_POST_ATTEMPTS} failed posts`, async () => {
    await handMatched("2026-09-01");
    const e = await completed("TEST-D1", "2026-09-10");
    qbo.mode = "down";
    for (let i = 1; i < MAX_POST_ATTEMPTS; i++) expect(await postDisbursementToQb(e.id)).toBe("failed");
    expect(await postDisbursementToQb(e.id)).toBe("needs_finance");
    expect((await stateOf(e.id)).qbMatchState).toBe("NEEDS_FINANCE");
    expect(await postDisbursementToQb(e.id)).toBe("waiting");
  });

  it("refuses a gift whose owner has no QuickBooks Class, naming the bucket", async () => {
    await handMatched("2026-09-01");
    const e = await completed("TEST-D1", "2026-09-10", [{ donation: 1000, ownerId: 2 }]);
    expect(await postDisbursementToQb(e.id)).toBe("failed");
    expect(qbo.posts).toHaveLength(0);
    const [failed] = await eventsOf("TEST-D1", QB_EVENT.FAILED);
    expect(failed.payload).toContain("bucket 2 has no QuickBooks Class");
  });

  it("outside prod sends only TEST- disbursements; prod never sends one", async () => {
    await handMatched("2026-09-01");
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
    await handMatched("2026-09-01");
    const big = await completed("TEST-BIG", "2026-09-10", [{ donation: MAX_CREATE_CENTS_PER_RUN + 1 }]);
    expect(await postDisbursementToQb(big.id)).toBe("queued");
    expect((await stateOf(big.id)).qbMatchState).toBe("NEEDS_FINANCE");
    expect(qbo.posts).toHaveLength(0);
  });

  it("a fresh claim is left alone; a stale one is taken over", async () => {
    await handMatched("2026-09-01");
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
    await handMatched("2026-09-01");
    for (let i = 0; i <= MAX_CREATES_PER_RUN; i++) await completed(`TEST-D${i}`, "2026-09-10", [{ donation: 100 + i }]);

    const counts = await runDonationQbPosting(orgId);

    expect(counts).toMatchObject({ posted: MAX_CREATES_PER_RUN, capped: "count" });
    expect(qbo.posts).toHaveLength(MAX_CREATES_PER_RUN);
  });

  it(`stops at ${MAX_CREATES_PER_DAY} creates per UTC day`, async () => {
    await handMatched("2026-09-01");
    await completed("TEST-D1", "2026-09-10");
    await db.workflowEvent.createMany({
      data: Array.from({ length: MAX_CREATES_PER_DAY }, () => ({ orgId, entityType: "disbursement", eventType: QB_EVENT.CREATED, occurredAt: new Date() })),
    });

    expect(await runDonationQbPosting(orgId)).toMatchObject({ posted: 0, capped: "day" });
    expect(qbo.posts).toHaveLength(0);
  });

  it("stops after three failures in a row", async () => {
    await handMatched("2026-09-01");
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

  /** The hand-matched line, with its deposit still in QuickBooks so it never drifts itself. */
  async function lined() {
    await handMatched("2026-09-01");
    qbo.deposits.push(handDeposit("920260901", "2026-09-01", 1450));
  }

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

  it("leaves the takeover line where it was when a matched record drifts", async () => {
    await lined();
    const e = await completed("TEST-D1", "2026-09-10");
    qbo.deposits.push(handDeposit("501", "2026-09-12", 1450));
    expect(await postDisbursementToQb(e.id)).toBe("matched");
    expect(await benevityTakeoverLine(db, orgId)).toBe("2026-09-10");

    qbo.deposits = [];
    await runDonationQbPosting(orgId);

    expect((await stateOf(e.id)).qbMatchState).toBe("DRIFT");
    expect(await benevityTakeoverLine(db, orgId)).toBe("2026-09-10");
  });

  it("pins a matched deposit's date on the first check, then catches a later date change", async () => {
    await lined();
    const e = await completed("TEST-D1", "2026-09-10");
    qbo.deposits.push(handDeposit("501", "2026-09-12", 1450));
    expect(await postDisbursementToQb(e.id)).toBe("matched");
    expect((await db.disbursementEvent.findUniqueOrThrow({ where: { id: e.id } })).qbDepositTxnDate).toBeNull();

    await runDonationQbPosting(orgId);
    expect(await db.disbursementEvent.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({
      qbMatchState: "MATCHED",
      qbDepositTxnDate: "2026-09-12",
    });

    deposit("501").TxnDate = "2026-09-13";
    await runDonationQbPosting(orgId);
    expect((await stateOf(e.id)).qbMatchState).toBe("DRIFT");
  });

  it("changes nothing when the QuickBooks read fails", async () => {
    const { e, qbTxnId } = await posted();
    qbo.mode = "down";
    expect(await runDonationQbPosting(orgId)).toMatchObject({ drift: { checked: 0, failed: 2 } });
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

  it("matches a picked hand deposit as MATCHED, records the finance actor, and moves the line", async () => {
    const e = await held("TEST-A", "AMBIGUOUS");
    qbo.deposits.push(handDeposit("501", "2026-09-12", 1450), handDeposit("502", "2026-09-12", 1450));

    const out = await resolve("TEST-A", { action: "match", qbTxnId: "502" });

    expect(out.DisbursementEvent).toMatchObject({ qbMatchState: "MATCHED", qbTxnId: "502" });
    expect(await stateOf(e.id)).toEqual({ qbMatchState: "MATCHED", qbTxnId: "502" });
    const [matched] = await eventsOf("TEST-A", QB_MATCHED_EVENT);
    expect(matched.actorUserId).toBe(1);
    expect(await benevityTakeoverLine(db, orgId)).toBe("2026-09-10");
    await expect(resolve("TEST-A", { action: "match", qbTxnId: "501" })).rejects.toMatchObject({ status: 409 });
  });

  it("takes a deposit carrying this disbursement's own key as CREATED, which never moves the line", async () => {
    const e = await held("TEST-A", "AMBIGUOUS");
    const key = qbKey("donation", `${orgId}:TEST-A`);
    qbo.deposits.push({ ...handDeposit("601", "2026-09-10", 1450), PrivateNote: `Benevity [checkin:${key}]` });

    await resolve("TEST-A", { action: "match", qbTxnId: "601" });

    expect(await stateOf(e.id)).toEqual({ qbMatchState: "CREATED", qbTxnId: "601" });
    expect(await eventsOf("TEST-A", QB_MATCHED_EVENT)).toHaveLength(0);
    expect(await benevityTakeoverLine(db, orgId)).toBeNull();
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

  it("refuses a deposit created for another record, and retry before the line", async () => {
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
    await handMatched("2026-09-01");
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
    await handMatched("2026-09-01");
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
    await handMatched("2026-09-01");
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
