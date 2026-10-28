// Income books and matches every deposit (QB_ENTRY_OWNERSHIP). Donation hands each completed
// disbursement's deposit to income, re-sends any income does not know, and once, before its
// first hand-over, moves its own QuickBooks holdings into income.
import { DisbursementPayloadV1 } from "@checkin/donations";
import { sumCents } from "@checkin/money";
import { db } from "../db";
import type {
  DonationDepositLine, DonationDepositStatus, DonationExpectedDeposit, DonationHeldState, DonationHolding, IncomeDeposits,
} from "../contract";
import type { DisbursementEvent } from "../generated/prisma/client";
import { recordEvent } from "../repositories/audit";
import { getIncomeDeposits } from "../runtime";
import { QB_MATCH_STATE } from "./qb-match";
import { QB_EVENT, STALE_CLAIM_MS, TEST_DISBURSEMENT_PREFIX, qbPostingOnAt } from "./qb-poster";

/** What finance and the screens are told when they act on a disbursement's deposit in donation. */
export const NOW_INCOMES = "This disbursement's deposit is now income's; resolve it in income's reconciliation queue";

/** The workflow event naming why the move last stopped; finance is alerted once per cause. */
export const HANDOVER_STOPPED = "DEPOSITS_HANDOVER_STOPPED";

/** Disbursement ids per depositStatus read. */
const STATUS_BATCH = 200;

const ROLE = { donation: "BENEVITY_DONATIONS", match: "BENEVITY_MATCHES", fees: "BENEVITY_FEES" } as const;
const DESCRIPTION = { donation: "Benevity donations", match: "Benevity matches", fees: "Benevity fees" } as const;

const SYSTEM = { actorUserId: null, actorUsername: "system:deposit-handover", correlationId: null };

/** Outside prod only TEST- disbursements are handed over; prod never hands one over. */
const sendable = (deposits: IncomeDeposits, disbursementId: string) => disbursementId.startsWith(TEST_DISBURSEMENT_PREFIX) !== deposits.prod;

/**
 * The deposit a completed disbursement should land as: one line per kind, account and bucket,
 * fees negative, an organization-level gift without a bucket. Throws when it cannot be built.
 */
export async function expectedDeposit(e: Pick<DisbursementEvent, "orgId" | "disbursementId" | "payload">): Promise<DonationExpectedDeposit> {
  const payload = DisbursementPayloadV1.parse(JSON.parse(e.payload));
  if (!payload.disbursementDate) throw new Error("the disbursement has no date");
  const gifts = new Map(
    (
      await db.transaction.findMany({
        where: { orgId: e.orgId, disbursementId: e.disbursementId },
        select: { transactionId: true, ownerId: true, isOrganizationalLevel: true },
      })
    ).map((t) => [t.transactionId, t]),
  );
  const lines = new Map<string, DonationDepositLine>();
  for (const item of payload.items) {
    const gift = gifts.get(item.transactionId);
    if (!gift) throw new Error(`gift ${item.transactionId} is not in the disbursement`);
    if (!gift.isOrganizationalLevel && gift.ownerId === null) throw new Error(`gift ${item.transactionId} has no owner`);
    const budgetOwnerId = gift.isOrganizationalLevel ? null : gift.ownerId;
    const key = `${item.type}|${item.account}|${budgetOwnerId ?? ""}`;
    const signed = item.type === "fees" ? -item.amountCents : item.amountCents;
    const prev = lines.get(key);
    lines.set(key, {
      role: ROLE[item.type],
      budgetOwnerId,
      amountCents: sumCents(prev?.amountCents ?? 0, signed),
      description: DESCRIPTION[item.type],
      accountName: item.account,
    });
  }
  const nonZero = [...lines.values()].filter((l) => l.amountCents !== 0);
  const netCents = sumCents(...nonZero.map((l) => l.amountCents));
  if (netCents <= 0) throw new Error("the disbursement nets to zero or less");
  return { txnDate: payload.disbursementDate, netCents, bankRole: "BENEVITY_BANK", lines: nonZero, memo: `Benevity disbursement ${e.disbursementId}` };
}

/** When donation's holdings moved to income, or null while they have not. */
export async function depositsHandedOverAt(orgId: string): Promise<Date | null> {
  return (await db.donationOrgSettings.findUnique({ where: { orgId } }))?.depositsHandedOverAt ?? null;
}

/**
 * Hand one disbursement's deposit to income, if it has completed. Called after the transaction
 * that may have completed it has committed, never inside it. Best effort: a failure is logged and
 * the re-send job hands it over later. Does nothing until the move has run.
 */
export async function handOverDeposit(orgId: string, disbursementId: string): Promise<void> {
  try {
    const deposits = getIncomeDeposits();
    if (!deposits || !sendable(deposits, disbursementId) || !(await depositsHandedOverAt(orgId))) return;
    const e = await db.disbursementEvent.findFirst({ where: { orgId, disbursementId } });
    if (e) await deposits.expectDeposit(orgId, disbursementId, await expectedDeposit(e));
  } catch (err) {
    console.warn(`[bulk-donation] handing disbursement ${disbursementId}'s deposit to income failed; the re-send job retries it`, err);
  }
}

/** handOverDeposit for each disbursement a committed transaction may have completed. */
export async function handOverDeposits(orgId: string, disbursementIds: Iterable<string>): Promise<void> {
  for (const id of new Set(disbursementIds)) await handOverDeposit(orgId, id);
}

/** Donation posts whose QuickBooks call may still be running: a POSTING claim younger than the stale time. */
export async function postsInFlight(orgId: string, now = new Date()): Promise<number> {
  const posting = await db.disbursementEvent.findMany({ where: { orgId, qbMatchState: QB_MATCH_STATE.POSTING }, select: { disbursementId: true } });
  let live = 0;
  for (const p of posting) {
    const claimed = await db.workflowEvent.findFirst({
      where: { orgId, entityType: "disbursement", entityId: p.disbursementId, eventType: QB_EVENT.CLAIMED },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      select: { occurredAt: true },
    });
    if (claimed && now.getTime() - claimed.occurredAt.getTime() <= STALE_CLAIM_MS) live++;
  }
  return live;
}

const HELD_STATE: Partial<Record<string, DonationHeldState>> = {
  [QB_MATCH_STATE.UNMATCHED]: "waiting",
  [QB_MATCH_STATE.WAITING]: "waiting",
  [QB_MATCH_STATE.POST_FAILED]: "waiting",
  // Only a stale claim is left once no post is in flight: a post that died mid-call.
  [QB_MATCH_STATE.POSTING]: "waiting",
  [QB_MATCH_STATE.MATCHED]: "matched",
  [QB_MATCH_STATE.CREATED]: "created",
  [QB_MATCH_STATE.AMBIGUOUS]: "ambiguous",
  [QB_MATCH_STATE.UNBOOKED]: "unbooked",
  [QB_MATCH_STATE.BEFORE_LINE]: "unbooked",
  [QB_MATCH_STATE.NEEDS_FINANCE]: "needs_finance",
  [QB_MATCH_STATE.DRIFT]: "drifted",
  [QB_MATCH_STATE.DISMISSED]: "dismissed",
};

/** Finance's dismissal of a disbursement: the reason, who and when, from its audit event. */
async function dismissalOf(e: DisbursementEvent): Promise<DonationHolding["dismissal"]> {
  const events = await db.workflowEvent.findMany({
    where: { orgId: e.orgId, entityType: "disbursement", entityId: e.disbursementId, eventType: QB_EVENT.STATE },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
  });
  for (const ev of events) {
    const p = JSON.parse(ev.payload ?? "{}") as { to?: string; reason?: string };
    if (p.to === QB_MATCH_STATE.DISMISSED) return { reason: p.reason ?? "dismissed in donations", byUserId: ev.actorUserId, at: ev.occurredAt };
  }
  return null;
}

/** One disbursement's holding, or a reason it cannot move. Null for a disbursement never sent to QuickBooks. */
async function holdingOf(e: DisbursementEvent): Promise<DonationHolding | string | null> {
  const mapped = HELD_STATE[e.qbMatchState];
  if (!mapped) return null;
  const state: DonationHeldState = (mapped === "matched" || mapped === "created") && !e.qbTxnId ? "waiting" : mapped;
  const settled = state === "matched" || state === "created" || state === "dismissed";
  let expected: DonationExpectedDeposit | null = null;
  try {
    expected = await expectedDeposit(e);
  } catch (err) {
    if (!settled) return `disbursement ${e.disbursementId} cannot be handed to income: ${err instanceof Error ? err.message : String(err)}`;
  }
  const txnDate = expected?.txnDate ?? e.qbDepositTxnDate ?? e.createdAt.toISOString().slice(0, 10);
  const netCents = expected?.netCents ?? e.qbDepositTotalCents;
  if (netCents === null) return `disbursement ${e.disbursementId} cannot be handed to income: its net is unknown`;
  return {
    sourceKey: e.disbursementId,
    createdAt: e.createdAt,
    txnDate,
    netCents,
    expected,
    state,
    depositId: state === "drifted" ? e.qbDriftedTxnId : state === "matched" || state === "created" ? e.qbTxnId : null,
    depositTxnDate: e.qbDepositTxnDate,
    depositTotalCents: e.qbDepositTotalCents,
    driftCause: e.qbDriftCause,
    createAttemptedAt: e.qbCreateAttemptedAt,
    note: e.qbNote,
    dismissal: state === "dismissed" ? await dismissalOf(e) : null,
  };
}

/** Record why the move stopped and alert finance, unless the last stop gave the same cause. */
async function stopped(deposits: IncomeDeposits, orgId: string, cause: string): Promise<void> {
  const last = await db.workflowEvent.findFirst({
    where: { orgId, entityType: "donation_org_settings", entityId: orgId, eventType: HANDOVER_STOPPED },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
  });
  if (last && (JSON.parse(last.payload ?? "{}") as { cause?: string }).cause === cause) return;
  // Recorded only once the alert went out, so a failed alert is sent again next run.
  await deposits.moveStopped({ orgId, cause });
  await recordEvent(db, { orgId, entityType: "donation_org_settings", entityId: orgId, eventType: HANDOVER_STOPPED, ...SYSTEM, payload: { cause } });
}

export type MoveOutcome = "moved" | "in_flight" | "stopped";

/**
 * The one-off move of donation's QuickBooks holdings into income, run by the hand-over job until it
 * succeeds. It waits while any donation post may still be in flight, then hands income every
 * disbursement's state, the exclusions and the posting stamp in one call, and sets the marker
 * that lets hand-overs begin. A stop (a deposit a payout already holds, a disbursement that
 * cannot be built) writes nothing and alerts finance once per cause; the next run tries again.
 */
export async function moveHoldings(deposits: IncomeDeposits, orgId: string, now = new Date()): Promise<MoveOutcome> {
  if ((await postsInFlight(orgId, now)) > 0) return "in_flight";
  const events = await db.disbursementEvent.findMany({ where: { orgId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const holdings: DonationHolding[] = [];
  const problems: string[] = [];
  for (const e of events) {
    if (!sendable(deposits, e.disbursementId)) continue;
    const h = await holdingOf(e);
    if (typeof h === "string") problems.push(h);
    else if (h) holdings.push(h);
  }
  try {
    if (problems.length) throw new Error(problems.join("; "));
    const exclusions = await db.donationQbMatchExclusion.findMany({ where: { orgId } });
    await deposits.adoptHoldings(orgId, {
      holdings,
      exclusions: exclusions.map((x) => ({ qbTxnId: x.qbTxnId, reason: x.reason, excludedByUserId: x.excludedByUserId, excludedAt: x.excludedAt })),
      postingOnAt: await qbPostingOnAt(orgId),
    });
  } catch (err) {
    await stopped(deposits, orgId, err instanceof Error ? err.message : String(err));
    return "stopped";
  }
  await db.donationOrgSettings.createMany({ data: [{ orgId }], skipDuplicates: true });
  await db.donationOrgSettings.updateMany({ where: { orgId, depositsHandedOverAt: null }, data: { depositsHandedOverAt: now } });
  await recordEvent(db, { orgId, entityType: "donation_org_settings", entityId: orgId, eventType: "DEPOSITS_HANDED_OVER", ...SYSTEM, payload: { disbursements: holdings.length } });
  return "moved";
}

export type HandOverCounts = { move: MoveOutcome | "done"; acknowledged: number; sent: number; failed: number };

/**
 * The daily hand-over job: the move while it has not run, then a re-send of every completed
 * disbursement income has not acknowledged. A repeat changes nothing in income.
 */
// ponytail: reads every completed disbursement each run; page by creation time if Benevity volume grows.
export async function runDonationDepositHandOver(orgId: string, now = new Date()): Promise<HandOverCounts | "unbound"> {
  const deposits = getIncomeDeposits();
  if (!deposits) return "unbound";
  const counts: HandOverCounts = { move: "done", acknowledged: 0, sent: 0, failed: 0 };
  if (!(await depositsHandedOverAt(orgId))) {
    counts.move = await moveHoldings(deposits, orgId, now);
    if (counts.move !== "moved") return counts;
  }
  const events = (await db.disbursementEvent.findMany({ where: { orgId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).filter((e) =>
    sendable(deposits, e.disbursementId),
  );
  for (let i = 0; i < events.length; i += STATUS_BATCH) {
    const batch = events.slice(i, i + STATUS_BATCH);
    const known = await deposits.depositStatus(orgId, batch.map((e) => e.disbursementId));
    for (const e of batch) {
      if (known[e.disbursementId]) {
        counts.acknowledged++;
        continue;
      }
      try {
        await deposits.expectDeposit(orgId, e.disbursementId, await expectedDeposit(e));
        counts.sent++;
      } catch (err) {
        counts.failed++;
        console.warn(`[bulk-donation] re-sending disbursement ${e.disbursementId}'s deposit to income failed`, err);
      }
    }
  }
  return counts;
}

/** A disbursement's QuickBooks fields as its screens show them: income's status once handed over. */
export function withIncomeStatus<T extends Pick<DisbursementEvent, "disbursementId" | "qbMatchState" | "qbTxnId" | "qbNote" | "qbDepositTotalCents" | "qbDepositTxnDate">>(
  row: T,
  status: DonationDepositStatus | undefined,
): T {
  if (!status) return { ...row, qbMatchState: QB_MATCH_STATE.UNMATCHED, qbTxnId: null, qbNote: null };
  switch (status.state) {
    case "waiting":
      return { ...row, qbMatchState: QB_MATCH_STATE.WAITING, qbTxnId: null, qbNote: null };
    case "booked":
    case "matched":
      return {
        ...row,
        qbMatchState: status.state === "booked" ? QB_MATCH_STATE.CREATED : QB_MATCH_STATE.MATCHED,
        qbTxnId: status.depositId,
        qbNote: null,
        qbDepositTotalCents: status.totalCents,
        qbDepositTxnDate: status.txnDate,
      };
    case "with_finance":
      return { ...row, qbMatchState: QB_MATCH_STATE.NEEDS_FINANCE, qbTxnId: null, qbNote: status.note };
    case "drifted":
      return { ...row, qbMatchState: QB_MATCH_STATE.DRIFT, qbTxnId: null, qbNote: status.note };
    case "dismissed":
      return { ...row, qbMatchState: QB_MATCH_STATE.DISMISSED, qbTxnId: null, qbNote: status.reason };
  }
}

/** The screens' rows with income's status in place of donation's own, once the holdings have moved. */
export async function withIncomeStatuses<T extends Parameters<typeof withIncomeStatus>[0]>(orgId: string, rows: T[]): Promise<T[]> {
  const deposits = getIncomeDeposits();
  if (!deposits || !rows.length || !(await depositsHandedOverAt(orgId))) return rows;
  const status = await deposits.depositStatus(orgId, rows.map((r) => r.disbursementId));
  return rows.map((r) => (sendable(deposits, r.disbursementId) ? withIncomeStatus(r, status[r.disbursementId]) : r));
}
