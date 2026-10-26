// The one-off move of donation's Benevity holdings into income (QB_ENTRY_OWNERSHIP, migration
// step 2). Donation calls it once, after its own poster is off and no post of its is in flight,
// and before it first hands a deposit over. One transaction: a stop writes nothing.
import { ServiceError } from "@checkin/component-kit";
import { db } from "../db";
import type { Prisma } from "../generated/prisma/client";
import { assertOrg, getIncomeConfig } from "../runtime";
import { parseExpected, type ExpectedDeposit } from "./intake";
import { depositsIn } from "./qb-deposits";
import { BENEVITY_MATCH_WINDOW_DAYS, DEPOSIT_SOURCE } from "./sources";
import { RECON_KIND, RECON_ORIGIN, RECON_RESOLUTION, RECON_STATUS, addDays, audit, lockReconciliation } from "./reconcile";

/** Where donation left a disbursement's deposit. */
export type BenevityHeldState = "waiting" | "matched" | "created" | "ambiguous" | "unbooked" | "needs_finance" | "drifted" | "dismissed";

/** One disbursement's QuickBooks state as donation holds it. */
export type BenevityHolding = {
  /** The disbursement id: the Benevity row's key. */
  sourceKey: string;
  /** When donation recorded the disbursement as completed; the row's createdAt, compared with switch-on. */
  createdAt: Date;
  /** YYYY-MM-DD. */
  txnDate: string;
  netCents: number;
  /** Null only on a settled holding (matched, created, dismissed) whose deposit can no longer be built. */
  expected: ExpectedDeposit | null;
  state: BenevityHeldState;
  /** The deposit held (matched, created), or the one a drifted holding was linked to. */
  depositId: string | null;
  depositTxnDate: string | null;
  depositTotalCents: number | null;
  driftCause: string | null;
  createAttemptedAt: Date | null;
  note: string | null;
  dismissal: { reason: string; byUserId: number | null; at: Date } | null;
};

export type BenevityExclusion = { qbTxnId: string; reason: string; excludedByUserId: number; excludedAt: Date };

export type BenevityMove = { holdings: BenevityHolding[]; exclusions: BenevityExclusion[]; postingOnAt: Date | null };

export type AdoptResult = { adopted: number; present: number; exclusions: number };

const HOLDS = new Set<BenevityHeldState>(["matched", "created"]);
const SETTLED = new Set<BenevityHeldState>(["matched", "created", "dismissed"]);

/** The note a drifted holding carries: income keeps no link to a deposit that changed. */
export const driftedNote = (depositId: string, cause: string | null) =>
  `was linked to Deposit ${depositId}, which changed after it was matched${cause ? ` (${cause})` : ""}`;

function rowData(orgId: string, h: BenevityHolding, expected: ExpectedDeposit | null): Prisma.PayoutReconciliationUncheckedCreateInput {
  const base = {
    orgId,
    source: DEPOSIT_SOURCE.BENEVITY,
    payoutGid: h.sourceKey,
    payoutDate: h.txnDate,
    payoutNetCents: h.netCents,
    createdAt: h.createdAt,
    qbCreateAttemptedAt: h.createAttemptedAt,
    qbNote: h.note,
    ...(expected ? { expected: { ...expected } } : {}),
  };
  const held = { depositId: h.depositId, depositTxnDate: h.depositTxnDate, depositTotalCents: h.depositTotalCents ?? h.netCents, resolution: RECON_RESOLUTION.AUTO };
  switch (h.state) {
    case "waiting":
      return { ...base, status: RECON_STATUS.WAITING };
    case "matched":
      return { ...base, ...held, status: RECON_STATUS.MATCHED, origin: RECON_ORIGIN.MATCHED };
    case "created":
      return { ...base, ...held, status: RECON_STATUS.POSTED, origin: RECON_ORIGIN.CREATED };
    case "ambiguous":
      return { ...base, status: RECON_STATUS.OPEN, kind: RECON_KIND.AMBIGUOUS_DEPOSIT };
    case "unbooked":
      return { ...base, status: RECON_STATUS.OPEN, kind: RECON_KIND.NO_DEPOSIT };
    case "needs_finance":
      return { ...base, status: RECON_STATUS.OPEN, kind: RECON_KIND.POST_FAILED };
    case "drifted": {
      const drift = h.depositId ? driftedNote(h.depositId, h.driftCause) : null;
      return { ...base, status: RECON_STATUS.OPEN, kind: RECON_KIND.DRIFT, qbNote: [h.note, drift].filter(Boolean).join("; ") || null };
    }
    case "dismissed":
      return {
        ...base,
        status: RECON_STATUS.RESOLVED,
        resolution: RECON_RESOLUTION.DISMISSED,
        reason: h.dismissal?.reason ?? "dismissed in donations",
        resolvedByUserId: h.dismissal?.byUserId ?? null,
        resolvedAt: h.dismissal?.at ?? null,
      };
  }
}

/**
 * Pin the booked date of a held deposit donation never dated, from the deposit itself when its
 * total still agrees; income's drift check reads a held deposit on its booked day.
 */
async function pinDates(holdings: BenevityHolding[]): Promise<BenevityHolding[]> {
  const unpinned = holdings.filter((h) => HOLDS.has(h.state) && h.depositId && !h.depositTxnDate);
  const source = getIncomeConfig().deposits;
  if (!unpinned.length || !source) return holdings;
  const read = await depositsIn(source, unpinned.map((h) => [addDays(h.txnDate, -BENEVITY_MATCH_WINDOW_DAYS), addDays(h.txnDate, BENEVITY_MATCH_WINDOW_DAYS)]));
  const byId = new Map(read.map((d) => [d.id, d]));
  return holdings.map((h) => {
    const d = h.depositId && !h.depositTxnDate ? byId.get(h.depositId) : undefined;
    return d && d.totalCents === (h.depositTotalCents ?? h.netCents) ? { ...h, depositTxnDate: d.txnDate } : h;
  });
}

/**
 * Write each holding as a Benevity row, donation's exclusions as income's, and Benevity's
 * switch-on as the earlier of income's and donation's. A row income already has is left as it
 * is, so a re-run after a crash writes only what is missing. Stops, writing nothing, on a
 * deposit income already holds under another key, or an unsettled holding with no deposit to build.
 */
export async function adoptBenevityDeposits(orgId: string, move: BenevityMove): Promise<AdoptResult> {
  await assertOrg(orgId);
  const unbuildable = move.holdings.filter((h) => !h.expected && !SETTLED.has(h.state)).map((h) => h.sourceKey);
  if (unbuildable.length) throw new ServiceError(409, `disbursement ${unbuildable.join(", ")} has no deposit income could book`);
  const parsed = new Map(move.holdings.map((h) => [h.sourceKey, h.expected ? parseExpected(h.expected) : null]));
  const holdings = await pinDates(move.holdings);

  return db.$transaction(
    async (tx) => {
      await lockReconciliation(tx, orgId, true);
      const keys = holdings.map((h) => h.sourceKey);
      const present = new Set(
        (await tx.payoutReconciliation.findMany({ where: { orgId, payoutGid: { in: keys } }, select: { payoutGid: true, source: true } })).map((r) => {
          if (r.source !== DEPOSIT_SOURCE.BENEVITY) throw new ServiceError(409, `disbursement ${r.payoutGid} shares its key with a ${r.source} row`);
          return r.payoutGid;
        }),
      );
      const heldIds = holdings.flatMap((h) => (HOLDS.has(h.state) && h.depositId ? [h.depositId] : []));
      const holders = await tx.payoutReconciliation.findMany({ where: { orgId, depositId: { in: heldIds } }, select: { id: true, payoutGid: true, depositId: true } });
      const clashes = holders.flatMap((r) => {
        const h = holdings.find((x) => x.depositId === r.depositId && HOLDS.has(x.state));
        return h && h.sourceKey !== r.payoutGid ? [`deposit ${r.depositId} held by disbursement ${h.sourceKey} is already held by payout ${r.id}`] : [];
      });
      if (clashes.length) throw new ServiceError(409, clashes.join("; "));

      let adopted = 0;
      for (const h of holdings) {
        if (present.has(h.sourceKey)) continue;
        const saved = await tx.payoutReconciliation.create({ data: rowData(orgId, h, parsed.get(h.sourceKey) ?? null) });
        await audit(tx, orgId, "reconciliation.adopted", null, saved, { userId: null, reason: `moved from donation as ${h.state}` });
        adopted++;
      }
      const { count: exclusions } = await tx.incomeQbMatchExclusion.createMany({
        data: move.exclusions.map((e) => ({ orgId, ...e })),
        skipDuplicates: true,
      });
      if (move.postingOnAt) {
        await tx.incomeOrgSettings.upsert({ where: { orgId }, create: { orgId }, update: {} });
        await tx.incomeOrgSettings.updateMany({
          where: { orgId, OR: [{ benevityQbPostingOnAt: null }, { benevityQbPostingOnAt: { gt: move.postingOnAt } }] },
          data: { benevityQbPostingOnAt: move.postingOnAt },
        });
      }
      return { adopted, present: present.size, exclusions };
    },
    { timeout: 60_000 },
  );
}
