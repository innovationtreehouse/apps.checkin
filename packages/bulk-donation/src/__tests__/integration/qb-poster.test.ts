/**
 * The QuickBooks drain: completed disbursements post as bank Deposits through the real
 * QuickBooksClient over an in-memory QBO company. Match before create; the key makes a retry safe.
 */
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { QuickBooksClient, qbKey, type QboDeposit } from "@inventory/quickbooks";
import { describeDb } from "../helpers/db";
import { db } from "../../db";
import { configureBulkDonation } from "../../runtime";
import type { OwnerInfo } from "../../contract";
import { makeFile, makeTransaction, TEST_ORG_ID } from "../helpers/factories";
import { QB_MATCHED_EVENT, QB_MATCH_STATE, benevityTakeoverLine, recordQbMatched } from "../../lib/qb-match";
import {
  MAX_CREATES_PER_DAY, MAX_CREATES_PER_RUN, MAX_CREATE_CENTS_PER_RUN, MAX_POST_ATTEMPTS, QB_EVENT, STALE_CLAIM_MS,
  donationClaimedDepositIds, postDisbursementToQb, runDonationQbPosting,
} from "../../lib/qb-poster";

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
