// Income books and matches every deposit (QB_ENTRY_OWNERSHIP). Donation hands each completed
// disbursement's deposit to income and re-sends any income does not know.
import { DisbursementPayloadV1 } from "@checkin/donations";
import { sumCents } from "@checkin/money";
import { TEST_PREFIX } from "@checkin/quickbooks";
import { db } from "../db";
import type { DonationDepositLine, DonationExpectedDeposit, IncomeDeposits } from "../contract";
import type { DisbursementEvent } from "../generated/prisma/client";
import { getIncomeDeposits } from "../runtime";

/** Disbursement ids per depositStatus read. */
const STATUS_BATCH = 200;

const ROLE = { donation: "BENEVITY_DONATIONS", match: "BENEVITY_MATCHES", fees: "BENEVITY_FEES" } as const;
const DESCRIPTION = { donation: "Benevity donations", match: "Benevity matches", fees: "Benevity fees" } as const;

/** Outside prod only a TEST_PREFIX disbursement is handed over; prod never hands one over. */
const sendable = (deposits: IncomeDeposits, disbursementId: string) => disbursementId.startsWith(TEST_PREFIX) !== deposits.prod;

/**
 * The deposit a completed disbursement should land as: one line per kind and bucket,
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
    const key = `${item.type}|${budgetOwnerId ?? ""}`;
    const signed = item.type === "fees" ? -item.amountCents : item.amountCents;
    const prev = lines.get(key);
    lines.set(key, {
      role: ROLE[item.type],
      budgetOwnerId,
      amountCents: sumCents(prev?.amountCents ?? 0, signed),
      description: DESCRIPTION[item.type],
    });
  }
  const nonZero = [...lines.values()].filter((l) => l.amountCents !== 0);
  const netCents = sumCents(...nonZero.map((l) => l.amountCents));
  if (netCents <= 0) throw new Error("the disbursement nets to zero or less");
  return { txnDate: payload.disbursementDate, netCents, bankRole: "BENEVITY_BANK", lines: nonZero, memo: `Benevity disbursement ${e.disbursementId}` };
}

/**
 * Hand one disbursement's deposit to income, if it has completed. Called after the transaction
 * that may have completed it has committed, never inside it. Best effort: a failure is logged and
 * the re-send job hands it over later.
 */
export async function handOverDeposit(orgId: string, disbursementId: string): Promise<void> {
  try {
    const deposits = getIncomeDeposits();
    if (!deposits || !sendable(deposits, disbursementId)) return;
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

export type HandOverCounts = { acknowledged: number; sent: number; failed: number };

/** The daily hand-over job: a re-send of every completed disbursement income has not acknowledged. A repeat changes nothing in income. */
// ponytail: reads every completed disbursement each run; page by creation time if Benevity volume grows.
export async function runDonationDepositHandOver(orgId: string): Promise<HandOverCounts | "unbound"> {
  const deposits = getIncomeDeposits();
  if (!deposits) return "unbound";
  const counts: HandOverCounts = { acknowledged: 0, sent: 0, failed: 0 };
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
