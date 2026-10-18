// The QuickBooks drain (design §7): one bank Deposit per completed Benevity disbursement,
// match before create, through checkin's guarded client.
import { DisbursementPayloadV1 } from "@checkin/donations";
import { dollarsToCents, sumCents } from "@checkin/money";
import { findOrCreate, qbKey, type FindOrCreateResult, type QboDeposit, type QuickBooksClient, type TxnWrite, type WriteLine } from "@checkin/quickbooks";
import { db, type PrismaTransactionClient } from "../db";
import type { DisbursementEvent } from "../generated/prisma/client";
import { recordEvent } from "../repositories/audit";
import { assertOrg, getOwnerDirectory, getQbPosting, otherLaneClaimedDepositIds } from "../runtime";
import { QB_MATCH_STATE, benevityTakeoverLine, recordQbMatched, type QbMatchState } from "./qb-match";

/** Days either side of the disbursement date a QuickBooks deposit may be dated. */
export const MATCH_WINDOW_DAYS = 7;
// ponytail: fixed caps, as expense's; move to an org settings row when finance needs to tune them.
export const MAX_CREATES_PER_RUN = 25;
export const MAX_CREATE_CENTS_PER_RUN = 2_500_000;
export const MAX_CREATES_PER_DAY = 50;
/** Failed posts before the drain stops retrying and hands the disbursement to finance. */
export const MAX_POST_ATTEMPTS = 5;
/** Consecutive failed posts after which a drain run stops: QuickBooks is likely down. */
export const MAX_CONSECUTIVE_FAILURES = 3;
/** A claim older than this belongs to a post that died between claim and settle; it may be taken over. */
export const STALE_CLAIM_MS = 10 * 60_000;
/** QuickBooks reads per run for the drift check: one read per checked disbursement. */
export const MAX_DRIFT_CHECKS_PER_RUN = 25;
/** Outside prod only these disbursements are sent; prod never sends one. */
export const TEST_DISBURSEMENT_PREFIX = "TEST-";

const POSTABLE: QbMatchState[] = [
  QB_MATCH_STATE.UNMATCHED,
  QB_MATCH_STATE.POST_FAILED,
  QB_MATCH_STATE.NOT_TEST_DATA,
  QB_MATCH_STATE.TEST_DATA_REFUSED,
];

/** Append-only workflow events the drain writes; claim time, attempts and the daily count are read from them. */
export const QB_EVENT = {
  CLAIMED: "QB_POST_CLAIMED",
  FAILED: "QB_POST_FAILED",
  /** Finance re-armed a disbursement; failures before it no longer count. */
  RETRIED: "QB_POST_RETRIED",
  CREATED: "QB_CREATED",
  STATE: "QB_MATCH_STATE",
  /** The deposit a disbursement held is gone or changed in QuickBooks; the record went to finance. */
  DRIFT: "QB_DRIFT",
} as const;

/** Why a booked deposit no longer stands. */
export const QB_DRIFT_CAUSE = { MISSING: "deposit_missing", CHANGED: "deposit_changed" } as const;
export type QbDriftCause = (typeof QB_DRIFT_CAUSE)[keyof typeof QB_DRIFT_CAUSE];

/** The deposit as booked: its total, and its date once known. */
export type Booked = { totalCents: number; txnDate: string | null };

const SYSTEM = { actorUserId: null, actorUsername: "system:qb-drain", correlationId: null };

export type PostOutcome = "posted" | "matched" | "queued" | "failed" | "waiting" | "not_sent" | "needs_finance" | "day_capped";

type Tx = PrismaTransactionClient;
type Claim = { before: DisbursementEvent; eventId: number };

function shiftDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parsePayload(json: string): DisbursementPayloadV1 {
  return DisbursementPayloadV1.parse(JSON.parse(json));
}

/** Signed cents an item adds to the deposit: gifts and matches in, fees out. */
function signedCents(item: DisbursementPayloadV1["items"][number]): number {
  return item.type === "fees" ? -item.amountCents : item.amountCents;
}

/** What the disbursement's Deposit totals. */
export function payloadNetCents(payloadJson: string): number {
  return sumCents(...parsePayload(payloadJson).items.map(signedCents));
}

function eventWhere(e: Pick<DisbursementEvent, "orgId" | "disbursementId">) {
  return { orgId: e.orgId, entityType: "disbursement" as const, entityId: e.disbursementId };
}

async function latestEvent(handle: Tx, e: DisbursementEvent, eventType: string) {
  return handle.workflowEvent.findFirst({
    where: { ...eventWhere(e), eventType },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    select: { id: true, occurredAt: true },
  });
}

async function lockedEvent(tx: Tx, id: number): Promise<DisbursementEvent> {
  await tx.$queryRaw`SELECT id FROM disbursement_events WHERE id = ${id} FOR UPDATE`;
  return tx.disbursementEvent.findUniqueOrThrow({ where: { id } });
}

async function isPostable(tx: Tx, e: DisbursementEvent, now = Date.now()): Promise<boolean> {
  if (e.qbTxnId) return false;
  if (e.qbMatchState === QB_MATCH_STATE.POSTING) {
    const claimed = await latestEvent(tx, e, QB_EVENT.CLAIMED);
    return !claimed || now - claimed.occurredAt.getTime() > STALE_CLAIM_MS;
  }
  return POSTABLE.includes(e.qbMatchState as QbMatchState);
}

/** Move the record to `to`, with one audit event; a re-check that lands where it was writes none. */
async function settle(
  tx: Tx,
  before: DisbursementEvent,
  outcome: PostOutcome,
  to: QbMatchState,
  opts: { qbTxnId?: string; note?: string; booked?: Booked } = {},
): Promise<PostOutcome> {
  await tx.disbursementEvent.update({
    where: { id: before.id },
    data: {
      qbMatchState: to,
      ...(opts.qbTxnId !== undefined && { qbTxnId: opts.qbTxnId }),
      ...(opts.booked && { qbDepositTotalCents: opts.booked.totalCents, qbDepositTxnDate: opts.booked.txnDate }),
    },
  });
  if (to === QB_MATCH_STATE.MATCHED && opts.qbTxnId) {
    const payload = parsePayload(before.payload);
    await recordQbMatched(tx, before.orgId, { disbursementId: before.disbursementId, disbursementDate: payload.disbursementDate, qbTxnId: opts.qbTxnId }, SYSTEM);
    return outcome;
  }
  if (before.qbMatchState === to && !opts.qbTxnId) return outcome;
  await recordEvent(tx, {
    ...eventWhere(before),
    disbursementId: before.disbursementId,
    eventType: to === QB_MATCH_STATE.CREATED ? QB_EVENT.CREATED : QB_EVENT.STATE,
    ...SYSTEM,
    payload: { from: before.qbMatchState, to, ...(opts.qbTxnId !== undefined && { qbTxnId: opts.qbTxnId }), ...(opts.note !== undefined && { note: opts.note }) },
  });
  return outcome;
}

/** Every failure is recorded; at the limit the drain stops retrying and finance takes it. */
async function recordFailure(tx: Tx, before: DisbursementEvent, error: string): Promise<PostOutcome> {
  const rearmed = await latestEvent(tx, before, QB_EVENT.RETRIED);
  const prior = await tx.workflowEvent.count({
    where: { ...eventWhere(before), eventType: QB_EVENT.FAILED, ...(rearmed && { occurredAt: { gt: rearmed.occurredAt } }) },
  });
  const attempt = prior + 1;
  const exhausted = attempt >= MAX_POST_ATTEMPTS;
  await recordEvent(tx, {
    ...eventWhere(before),
    disbursementId: before.disbursementId,
    eventType: QB_EVENT.FAILED,
    ...SYSTEM,
    payload: { attempt, of: MAX_POST_ATTEMPTS, error: error.slice(0, 500) },
  });
  const to = exhausted ? QB_MATCH_STATE.NEEDS_FINANCE : QB_MATCH_STATE.POST_FAILED;
  return settle(tx, before, exhausted ? "needs_finance" : "failed", to, { note: `attempt ${attempt} of ${MAX_POST_ATTEMPTS}` });
}

function utcMidnight(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Deposits this lane created today (UTC). */
export function createdToday(handle: Tx, orgId: string): Promise<number> {
  return handle.workflowEvent.count({ where: { orgId, eventType: QB_EVENT.CREATED, occurredAt: { gte: utcMidnight() } } });
}

/** Deposits this lane holds, for another lane to keep out of its own matching. */
export async function donationClaimedDepositIds(orgId: string): Promise<string[]> {
  await assertOrg(orgId);
  const rows = await db.disbursementEvent.findMany({ where: { orgId, qbTxnId: { not: null } }, select: { qbTxnId: true } });
  return rows.flatMap((r) => (r.qbTxnId ? [r.qbTxnId] : []));
}

/**
 * The Deposit for one disbursement: one line per (kind, account, Class), fees negative. Each
 * gift's Class is its owner's at post time; an organizational-level gift carries none.
 */
async function buildWrite(client: QuickBooksClient, bankAccountId: string, e: DisbursementEvent): Promise<TxnWrite> {
  const payload = parsePayload(e.payload);
  if (!payload.disbursementDate) throw new Error("the disbursement has no date");
  const gifts = new Map(
    (
      await db.transaction.findMany({
        where: { orgId: e.orgId, disbursementId: e.disbursementId },
        select: { transactionId: true, ownerId: true, isOrganizationalLevel: true },
      })
    ).map((t) => [t.transactionId, t]),
  );
  const owners = new Map((await getOwnerDirectory().list()).map((o) => [o.id, o]));
  const accounts = new Map<string, Promise<string>>();
  const accountId = (name: string) => {
    if (!accounts.has(name)) {
      accounts.set(
        name,
        client.accountNamed(name).then((a) => {
          if (!a) throw new Error(`QuickBooks has no account named "${name}"`);
          return a.Id;
        }),
      );
    }
    return accounts.get(name)!;
  };
  const classOf = (transactionId: string): string | undefined => {
    const gift = gifts.get(transactionId);
    if (!gift) throw new Error(`gift ${transactionId} is not in the disbursement`);
    if (gift.isOrganizationalLevel) return undefined;
    if (gift.ownerId === null) throw new Error(`gift ${transactionId} has no owner`);
    const owner = owners.get(gift.ownerId);
    if (!owner) throw new Error(`bucket ${gift.ownerId} is not in the owner directory`);
    if (owner.archivedAt) throw new Error(`bucket ${gift.ownerId} is archived`);
    if (!owner.quickBooksClassId) throw new Error(`bucket ${gift.ownerId} has no QuickBooks Class`);
    return owner.quickBooksClassId;
  };

  const DESCRIPTION = { donation: "Benevity donations", match: "Benevity matches", fees: "Benevity fees" } as const;
  const lines = new Map<string, WriteLine>();
  for (const item of payload.items) {
    const line = { accountId: await accountId(item.account), classId: classOf(item.transactionId) };
    const key = `${item.type}|${line.accountId}|${line.classId ?? ""}`;
    const prev = lines.get(key);
    const amountCents = sumCents(prev?.amountCents ?? 0, signedCents(item));
    lines.set(key, { ...line, amountCents, description: DESCRIPTION[item.type] });
  }
  const nonZero = [...lines.values()].filter((l) => l.amountCents !== 0);
  if (sumCents(...nonZero.map((l) => l.amountCents)) <= 0) throw new Error("the disbursement nets to zero or less");
  return {
    entity: "Deposit",
    fields: {
      txnDate: payload.disbursementDate,
      depositToAccountId: bankAccountId,
      lines: nonZero,
      memo: `Benevity disbursement ${e.disbursementId}`,
    },
  };
}

type Claimed = { claim: Claim; overCap: boolean };

/** Lock, gate, and claim (POSTING) the disbursement; anything else settles here and returns its outcome. */
function claimForPost(prod: boolean, id: number): Promise<PostOutcome | Claimed> {
  return db.$transaction(async (tx): Promise<PostOutcome | Claimed> => {
    const locked = await lockedEvent(tx, id);
    if (!(await isPostable(tx, locked))) return "waiting";
    // A stale claim is a post that died mid-call; it settles as a retry of a failed post.
    const current = locked.qbMatchState === QB_MATCH_STATE.POSTING ? { ...locked, qbMatchState: QB_MATCH_STATE.POST_FAILED } : locked;

    const test = current.disbursementId.startsWith(TEST_DISBURSEMENT_PREFIX);
    if (prod && test) return settle(tx, current, "not_sent", QB_MATCH_STATE.TEST_DATA_REFUSED, { note: "test data is never posted in prod" });
    if (!prod && !test) return settle(tx, current, "not_sent", QB_MATCH_STATE.NOT_TEST_DATA, { note: "only TEST- disbursements are posted outside prod" });

    let net: number;
    try {
      net = payloadNetCents(current.payload);
    } catch (err) {
      return recordFailure(tx, current, err instanceof Error ? err.message : String(err));
    }
    // Over the cap a disbursement is only matched, never created, so it does not count toward the day.
    const overCap = net > MAX_CREATE_CENTS_PER_RUN;
    if (!overCap && (await createdToday(tx, current.orgId)) >= MAX_CREATES_PER_DAY) return "day_capped";

    await tx.disbursementEvent.update({ where: { id }, data: { qbMatchState: QB_MATCH_STATE.POSTING } });
    const claimed = await recordEvent(tx, {
      ...eventWhere(current),
      disbursementId: current.disbursementId,
      eventType: QB_EVENT.CLAIMED,
      ...SYSTEM,
    });
    return { claim: { before: current, eventId: claimed.id }, overCap };
  });
}

/** Lock the record and run `fn` only while `claim` is still the one on it. */
function withClaim(id: number, claim: Claim, fn: (tx: Tx) => Promise<PostOutcome>): Promise<PostOutcome> {
  return db.$transaction(async (tx) => {
    const current = await lockedEvent(tx, id);
    const latest = await latestEvent(tx, current, QB_EVENT.CLAIMED);
    if (current.qbMatchState !== QB_MATCH_STATE.POSTING || latest?.id !== claim.eventId) return "waiting";
    return fn(tx);
  });
}

/**
 * One disbursement's turn. found by amount → MATCHED (moves the takeover line); found by key or
 * created → CREATED; ambiguous → AMBIGUOUS; before the line → BEFORE_LINE; no line → left as it
 * is; a failure → POST_FAILED, then NEEDS_FINANCE after MAX_POST_ATTEMPTS. Over the per-run cents
 * cap it is matched only, and NEEDS_FINANCE when nothing matches.
 *
 * Claim, call, settle: the record is claimed under its row lock, the QuickBooks calls run outside
 * any transaction, and the outcome settles only if the claim is still ours. A crash after
 * QuickBooks accepts is safe: the Deposit carries the record's key, so the takeover finds it.
 */
export async function postDisbursementToQb(id: number): Promise<PostOutcome | "unbound"> {
  const posting = getQbPosting();
  const client = await posting?.client();
  if (!posting || !client) return "unbound";
  const claimed = await claimForPost(posting.prod, id);
  if (typeof claimed === "string") return claimed;
  const { claim, overCap } = claimed;
  const { before } = claim;

  try {
    const write = await buildWrite(client, posting.bankAccountId, before);
    const [line, held, foreign, excluded] = await Promise.all([
      overCap ? Promise.resolve(null) : benevityTakeoverLine(db, before.orgId),
      donationClaimedDepositIds(before.orgId),
      otherLaneClaimedDepositIds(before.orgId),
      db.donationQbMatchExclusion.findMany({ where: { orgId: before.orgId }, select: { qbTxnId: true } }),
    ]);
    const date = write.fields.txnDate;
    const result: FindOrCreateResult = await findOrCreate(client, {
      write,
      key: qbKey("donation", `${before.orgId}:${before.disbursementId}`),
      window: { from: shiftDate(date, -MATCH_WINDOW_DAYS), to: shiftDate(date, MATCH_WINDOW_DAYS) },
      // With no line, a closed date before the record's own makes every miss needs-finance.
      closedThrough: line ?? shiftDate(date, -1),
      mayCreate: line !== null,
      claimedIds: new Set([...held, ...foreign]),
      excludedIds: new Set(excluded.map((x) => x.qbTxnId)),
    });

    return await withClaim(id, claim, async (tx) => {
      switch (result.kind) {
        case "found":
        case "created": {
          const byAmount = result.kind === "found" && result.via === "amount";
          const holder = await tx.disbursementEvent.findFirst({ where: { orgId: before.orgId, qbTxnId: result.id }, select: { id: true } });
          if (holder) {
            const note = `QuickBooks Deposit ${result.id} is already claimed by another disbursement${byAmount ? "" : "; the Deposit posted for this one needs voiding"}`;
            return settle(tx, before, "queued", QB_MATCH_STATE.AMBIGUOUS, { note });
          }
          // A created deposit carries the write's date; a found one's date is pinned by the first drift check.
          const booked: Booked = {
            totalCents: sumCents(...write.fields.lines.map((l) => l.amountCents)),
            txnDate: result.kind === "created" ? date : null,
          };
          return byAmount
            ? settle(tx, before, "matched", QB_MATCH_STATE.MATCHED, { qbTxnId: result.id, booked })
            : settle(tx, before, "posted", QB_MATCH_STATE.CREATED, { qbTxnId: result.id, booked });
        }
        case "ambiguous":
          return settle(tx, before, "queued", QB_MATCH_STATE.AMBIGUOUS, { note: `candidates: ${result.ids.join(", ")}` });
        case "closed":
          return settle(tx, before, "queued", QB_MATCH_STATE.BEFORE_LINE);
        case "needs-finance":
          return overCap
            ? settle(tx, before, "queued", QB_MATCH_STATE.NEEDS_FINANCE, { note: `net is over the per-run cap of ${MAX_CREATE_CENTS_PER_RUN} cents` })
            : settle(tx, before, "waiting", before.qbMatchState as QbMatchState);
        case "failed":
          return recordFailure(tx, before, result.error);
      }
    });
  } catch (err) {
    // The failing transaction rolled back, so the failure is recorded in a fresh one.
    const error = err instanceof Error ? err.message : String(err);
    return withClaim(id, claim, (tx) => recordFailure(tx, before, error));
  }
}

export type DriftCounts = { checked: number; drifted: number; failed: number };

export type DrainCounts = Record<Exclude<PostOutcome, "day_capped">, number> & {
  capped: "count" | "cents" | "day" | null;
  stoppedAfterFailures: boolean;
  drift: DriftCounts;
};

/** Why a held deposit no longer agrees with what was booked, or null while it does. */
export function driftCause(booked: Booked, deposit: QboDeposit | undefined): QbDriftCause | null {
  if (!deposit) return QB_DRIFT_CAUSE.MISSING;
  if (dollarsToCents(deposit.TotalAmt) !== booked.totalCents) return QB_DRIFT_CAUSE.CHANGED;
  if (booked.txnDate !== null && deposit.TxnDate !== booked.txnDate) return QB_DRIFT_CAUSE.CHANGED;
  return null;
}

/**
 * The slice of `rows` to check today. The start moves by the cap each UTC day, so every row is
 * checked within ceil(n / cap) days without storing a cursor.
 */
function todaysSlice<T>(rows: T[], cap: number, now: Date): T[] {
  if (rows.length <= cap) return rows;
  const start = (Math.floor(now.getTime() / 86_400_000) * cap) % rows.length;
  return [...rows, ...rows].slice(start, start + cap);
}

/**
 * Re-reads the deposit each MATCHED or CREATED disbursement holds. A deposit gone from its booked
 * day or bank account, or whose total or date moved, sends the record to finance as DRIFT: the
 * deposit id moves to qbDriftedTxnId, which frees it from the claimed set, and DRIFT is never
 * posted or matched again automatically. QuickBooks is only read. A deposit with no booked date is
 * read across its match window and, while its total still agrees, its date is pinned as booked.
 * A failed read changes nothing. Capped at MAX_DRIFT_CHECKS_PER_RUN reads.
 */
export async function checkDonationQbDrift(
  orgId: string,
  client: QuickBooksClient,
  bankAccountId: string,
  now = new Date(),
): Promise<DriftCounts> {
  const held = await db.disbursementEvent.findMany({
    where: { orgId, qbTxnId: { not: null }, qbMatchState: { in: [QB_MATCH_STATE.MATCHED, QB_MATCH_STATE.CREATED] } },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  const counts: DriftCounts = { checked: 0, drifted: 0, failed: 0 };
  for (const { id } of todaysSlice(held, MAX_DRIFT_CHECKS_PER_RUN, now)) {
    try {
      const row = await db.disbursementEvent.findUniqueOrThrow({ where: { id } });
      const booked: Booked = { totalCents: row.qbDepositTotalCents ?? payloadNetCents(row.payload), txnDate: row.qbDepositTxnDate };
      const day = booked.txnDate ?? parsePayload(row.payload).disbursementDate;
      if (!day || !row.qbTxnId) continue;
      const [from, to] = booked.txnDate ? [day, day] : [shiftDate(day, -MATCH_WINDOW_DAYS), shiftDate(day, MATCH_WINDOW_DAYS)];
      const deposit = (await client.depositsBetween(from, to)).find(
        (d) => d.Id === row.qbTxnId && d.DepositToAccountRef?.value === bankAccountId,
      );
      counts.checked++;
      if (await settleDriftCheck(id, row.qbTxnId, booked, deposit)) counts.drifted++;
    } catch (err) {
      counts.failed++;
      console.warn(`[bulk-donation] drift check of disbursement event ${id} failed`, err);
    }
  }
  return counts;
}

/** Settle one drift check under the row lock, only while the record still holds `qbTxnId`. True when it drifted. */
function settleDriftCheck(id: number, qbTxnId: string, booked: Booked, deposit: QboDeposit | undefined): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const current = await lockedEvent(tx, id);
    const holds = current.qbMatchState === QB_MATCH_STATE.MATCHED || current.qbMatchState === QB_MATCH_STATE.CREATED;
    if (!holds || current.qbTxnId !== qbTxnId) return false;
    const cause = driftCause(booked, deposit);
    if (!cause) {
      if (deposit && current.qbDepositTxnDate === null) {
        await tx.disbursementEvent.update({ where: { id }, data: { qbDepositTotalCents: booked.totalCents, qbDepositTxnDate: deposit.TxnDate } });
      }
      return false;
    }
    await tx.disbursementEvent.update({
      where: { id },
      data: { qbMatchState: QB_MATCH_STATE.DRIFT, qbTxnId: null, qbDriftedTxnId: qbTxnId, qbDriftCause: cause, qbDepositTotalCents: booked.totalCents },
    });
    await recordEvent(tx, {
      ...eventWhere(current),
      disbursementId: current.disbursementId,
      eventType: QB_EVENT.DRIFT,
      ...SYSTEM,
      payload: {
        from: current.qbMatchState,
        to: QB_MATCH_STATE.DRIFT,
        cause,
        qbTxnId,
        booked,
        now: deposit ? { totalCents: dollarsToCents(deposit.TotalAmt), txnDate: deposit.TxnDate } : null,
      },
    });
    return true;
  });
}

/**
 * The drain, run from the daily cron. First the drift check over the deposits already held; then
 * every completed disbursement not yet in QuickBooks, oldest
 * first. Stops at the per-run count and cents caps (measured on what it creates), the daily cap,
 * or MAX_CONSECUTIVE_FAILURES failures in a row; the rest waits for the next run. Counts only.
 */
export async function runDonationQbPosting(orgId: string, now = new Date()): Promise<DrainCounts | "unbound"> {
  const posting = getQbPosting();
  const client = await posting?.client();
  if (!posting || !client) return "unbound";
  const drift = await checkDonationQbDrift(orgId, client, posting.bankAccountId, now);
  const due = await db.disbursementEvent.findMany({
    where: { orgId, qbTxnId: null, qbMatchState: { in: [...POSTABLE, QB_MATCH_STATE.POSTING] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, payload: true },
  });

  const counts: DrainCounts = {
    posted: 0, matched: 0, queued: 0, failed: 0, waiting: 0, not_sent: 0, needs_finance: 0,
    capped: null, stoppedAfterFailures: false, drift,
  };
  let postedCents = 0;
  let failuresInARow = 0;
  for (const e of due) {
    let cents = 0;
    try {
      cents = payloadNetCents(e.payload);
    } catch {
      // an unreadable payload is recorded as a failure by the post itself
    }
    const createsAllowed = cents <= MAX_CREATE_CENTS_PER_RUN;
    if (createsAllowed && (counts.posted >= MAX_CREATES_PER_RUN || postedCents + cents > MAX_CREATE_CENTS_PER_RUN)) {
      counts.capped = counts.posted >= MAX_CREATES_PER_RUN ? "count" : "cents";
      break;
    }
    const outcome = await postDisbursementToQb(e.id);
    if (outcome === "unbound") break;
    if (outcome === "day_capped") {
      counts.capped = "day";
      break;
    }
    counts[outcome]++;
    if (outcome === "posted") postedCents += cents;
    failuresInARow = outcome === "failed" || outcome === "needs_finance" ? failuresInARow + 1 : 0;
    if (failuresInARow >= MAX_CONSECUTIVE_FAILURES) {
      counts.stoppedAfterFailures = true;
      break;
    }
  }
  return counts;
}
