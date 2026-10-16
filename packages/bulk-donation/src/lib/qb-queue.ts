// Finance's QuickBooks queue (design §7): the disbursements the drain holds, their live
// candidate Deposits, and the resolutions — pick a Deposit, dismiss, or re-arm for the drain.
import { appKeyOf, depositCandidate, qbKey } from "@inventory/quickbooks";
import { db, isUniqueConstraintError, type PrismaTransactionClient } from "../db";
import type { DisbursementEvent } from "../generated/prisma/client";
import { recordEvent } from "../repositories/audit";
import { getQbPosting, otherLaneClaimedDepositIds } from "../runtime";
import { ServiceError } from "../services/serviceError";
import type { AuditContext } from "../workflows/disbursement.actor";
import { QB_MATCH_STATE, recordQbMatched, type QbMatchState } from "./qb-match";
import { QB_HELD_STATES, QB_RETRYABLE_STATES } from "./qb-queue-states";
import { MATCH_WINDOW_DAYS, QB_EVENT, donationClaimedDepositIds, payloadNetCents, postDisbursementToQb } from "./qb-poster";

export interface QbCandidate {
  id: string;
  type: "Deposit";
  date: string;
  amountCents: number;
  memo: string | null;
}

export type QbResolveAction =
  | { action: "match"; qbTxnId: string; reason?: string }
  | { action: "dismiss"; reason: string }
  | { action: "retry" };

const isState = (list: readonly QbMatchState[], state: string) => list.some((s) => s === state);

function shiftDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function disbursementDate(e: DisbursementEvent): string {
  const date = (JSON.parse(e.payload) as { disbursementDate?: string | null }).disbursementDate;
  if (!date) throw new ServiceError(409, "The disbursement has no date");
  return date;
}

function donationKey(e: Pick<DisbursementEvent, "orgId" | "disbursementId">): string {
  return qbKey("donation", `${e.orgId}:${e.disbursementId}`);
}

async function heldEvent(orgId: string, disbursementId: string): Promise<DisbursementEvent> {
  const e = await db.disbursementEvent.findFirst({ where: { orgId, disbursementId } });
  if (!e) throw new ServiceError(404, "Disbursement event not found");
  return e;
}

async function lockedEvent(tx: PrismaTransactionClient, id: number): Promise<DisbursementEvent> {
  await tx.$queryRaw`SELECT id FROM disbursement_events WHERE id = ${id} FOR UPDATE`;
  return tx.disbursementEvent.findUniqueOrThrow({ where: { id } });
}

/**
 * Deposits into the donation bank account dated within ±MATCH_WINDOW_DAYS of the disbursement,
 * read live from QuickBooks, less those this lane or income holds and those finance excluded.
 */
async function liveCandidates(e: DisbursementEvent): Promise<(QbCandidate & { appKey?: string })[]> {
  const posting = getQbPosting();
  const client = await posting?.client();
  if (!posting || !client) throw new ServiceError(503, "QuickBooks is not connected");
  const date = disbursementDate(e);
  const [deposits, held, foreign, excluded] = await Promise.all([
    client.depositsBetween(shiftDate(date, -MATCH_WINDOW_DAYS), shiftDate(date, MATCH_WINDOW_DAYS)),
    donationClaimedDepositIds(e.orgId),
    otherLaneClaimedDepositIds(e.orgId),
    db.donationQbMatchExclusion.findMany({ where: { orgId: e.orgId }, select: { qbTxnId: true } }),
  ]);
  const taken = new Set([...held, ...foreign, ...excluded.map((x) => x.qbTxnId)]);
  return deposits
    .filter((d) => d.DepositToAccountRef?.value === posting.bankAccountId && !taken.has(d.Id))
    .map((d) => {
      const c = depositCandidate(d, appKeyOf);
      return { id: c.id, type: "Deposit" as const, date: c.date, amountCents: c.amountCents, memo: d.PrivateNote ?? null, appKey: c.appKey };
    });
}

export async function qbCandidates(orgId: string, disbursementId: string): Promise<QbCandidate[]> {
  return (await liveCandidates(await heldEvent(orgId, disbursementId))).map((c) => ({
    id: c.id, type: c.type, date: c.date, amountCents: c.amountCents, memo: c.memo,
  }));
}

/**
 * Tie a held disbursement to a Deposit finance picked. A Deposit carrying this disbursement's
 * key is the app's own (CREATED, no match event); one carrying another key is refused; any other
 * is a hand entry (MATCHED, which moves the takeover line). A differing amount needs a reason.
 */
async function pick(orgId: string, disbursementId: string, qbTxnId: string, reason: string | undefined, actor: AuditContext) {
  const why = reason?.trim() || null;
  const e = await heldEvent(orgId, disbursementId);
  if (!isState(QB_HELD_STATES, e.qbMatchState)) throw new ServiceError(409, "Only a held disbursement can be matched");
  const deposit = (await liveCandidates(e)).find((c) => c.id === qbTxnId);
  if (!deposit) throw new ServiceError(422, "Deposit is not an unclaimed candidate for this disbursement");
  if (deposit.amountCents !== payloadNetCents(e.payload) && !why) {
    throw new ServiceError(400, "A reason is required when the deposit amount differs from the disbursement");
  }
  const own = deposit.appKey === donationKey(e);
  if (deposit.appKey !== undefined && !own) throw new ServiceError(409, "Deposit was created for another record; void or exclude it in QuickBooks");
  const to = own ? QB_MATCH_STATE.CREATED : QB_MATCH_STATE.MATCHED;

  try {
    return await db.$transaction(async (tx) => {
      const current = await lockedEvent(tx, e.id);
      if (!isState(QB_HELD_STATES, current.qbMatchState)) throw new ServiceError(409, "Already resolved");
      const saved = await tx.disbursementEvent.update({ where: { id: e.id }, data: { qbMatchState: to, qbTxnId } });
      if (!own) await recordQbMatched(tx, orgId, { disbursementId, disbursementDate: disbursementDate(e), qbTxnId }, actor);
      await recordEvent(tx, {
        orgId,
        disbursementId,
        entityType: "disbursement",
        entityId: disbursementId,
        eventType: QB_EVENT.STATE,
        ...actor,
        payload: { from: current.qbMatchState, to, qbTxnId, manual: true, ...(why && { reason: why }) },
      });
      return saved;
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new ServiceError(409, "Deposit already backs another disbursement");
    throw err;
  }
}

/**
 * Hand a held disbursement back to the drain: QB_POST_RETRIED resets its attempt count, then one
 * post runs now through the drain's own gate. While QuickBooks posting is off the post answers
 * "unbound" and the record stays re-armed for the next drain run; nothing reaches QuickBooks.
 */
async function retry(orgId: string, disbursementId: string, actor: AuditContext): Promise<DisbursementEvent> {
  const e = await heldEvent(orgId, disbursementId);
  await db.$transaction(async (tx) => {
    const current = await lockedEvent(tx, e.id);
    if (!isState(QB_RETRYABLE_STATES, current.qbMatchState)) throw new ServiceError(409, "This disbursement cannot be retried");
    await tx.disbursementEvent.update({ where: { id: e.id }, data: { qbMatchState: QB_MATCH_STATE.UNMATCHED } });
    await recordEvent(tx, {
      orgId,
      disbursementId,
      entityType: "disbursement",
      entityId: disbursementId,
      eventType: QB_EVENT.RETRIED,
      ...actor,
      payload: { from: current.qbMatchState },
    });
  });
  await postDisbursementToQb(e.id);
  return db.disbursementEvent.findUniqueOrThrow({ where: { id: e.id } });
}

/** Settle a held disbursement with no QuickBooks deposit to tie it to; the drain never touches it again. */
async function dismiss(orgId: string, disbursementId: string, reason: string, actor: AuditContext): Promise<DisbursementEvent> {
  const why = reason.trim();
  if (!why) throw new ServiceError(400, "A reason is required");
  const e = await heldEvent(orgId, disbursementId);
  return db.$transaction(async (tx) => {
    const current = await lockedEvent(tx, e.id);
    if (!isState(QB_HELD_STATES, current.qbMatchState)) throw new ServiceError(409, "Only a held disbursement can be dismissed");
    const saved = await tx.disbursementEvent.update({ where: { id: e.id }, data: { qbMatchState: QB_MATCH_STATE.DISMISSED } });
    await recordEvent(tx, {
      orgId,
      disbursementId,
      entityType: "disbursement",
      entityId: disbursementId,
      eventType: QB_EVENT.STATE,
      ...actor,
      payload: { from: current.qbMatchState, to: QB_MATCH_STATE.DISMISSED, manual: true, reason: why },
    });
    return saved;
  });
}

export async function resolveQbHold(orgId: string, disbursementId: string, req: QbResolveAction, actor: AuditContext): Promise<DisbursementEvent> {
  switch (req.action) {
    case "match":
      return pick(orgId, disbursementId, req.qbTxnId, req.reason, actor);
    case "dismiss":
      return dismiss(orgId, disbursementId, req.reason, actor);
    case "retry":
      return retry(orgId, disbursementId, actor);
  }
}
