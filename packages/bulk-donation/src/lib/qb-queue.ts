// Finance's QuickBooks queue (design §7): the disbursements the drain held and their live
// candidate Deposits. Income now owns every deposit; only clearing a note is left here.
import { ServiceError } from "@checkin/component-kit";
import { appKeyOf, depositCandidate } from "@checkin/quickbooks";
import { db, type PrismaTransactionClient } from "../db";
import type { DisbursementEvent } from "../generated/prisma/client";
import { recordEvent } from "../repositories/audit";
import { getQbPosting, otherLaneClaimedDepositIds } from "../runtime";
import type { AuditContext } from "../workflows/disbursement.actor";
import { NOW_INCOMES } from "./deposit-handover";
import { MATCH_WINDOW_DAYS, QB_EVENT, donationClaimedDepositIds } from "./qb-poster";

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
  | { action: "retry" }
  | { action: "book" }
  | { action: "clear"; reason: string };

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

/** Answer a record's note without another action, for example after voiding a stray Deposit in QuickBooks. */
async function clearNote(orgId: string, disbursementId: string, reason: string, actor: AuditContext): Promise<DisbursementEvent> {
  const why = reason.trim();
  if (!why) throw new ServiceError(400, "A reason is required");
  const e = await heldEvent(orgId, disbursementId);
  return db.$transaction(async (tx) => {
    const current = await lockedEvent(tx, e.id);
    if (current.qbNote === null) throw new ServiceError(409, "The disbursement has no note");
    const saved = await tx.disbursementEvent.update({ where: { id: e.id }, data: { qbNote: null } });
    await recordEvent(tx, {
      orgId,
      disbursementId,
      entityType: "disbursement",
      entityId: disbursementId,
      eventType: QB_EVENT.NOTE_CLEARED,
      ...actor,
      payload: { qbNote: current.qbNote, reason: why },
    });
    return saved;
  });
}

/**
 * Finance's actions on a disbursement's deposit. Income owns every deposit, so match, dismiss,
 * retry and book are refused, pointing finance at income's queue; clearing a note still works.
 */
export async function resolveQbHold(orgId: string, disbursementId: string, req: QbResolveAction, actor: AuditContext): Promise<DisbursementEvent> {
  if (req.action === "clear") return clearNote(orgId, disbursementId, req.reason, actor);
  throw new ServiceError(409, NOW_INCOMES);
}
