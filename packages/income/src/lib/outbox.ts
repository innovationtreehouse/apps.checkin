import { findOrCreate, takeoverLine, type FindOrCreateResult, type TxnWrite, type WriteLine } from "@inventory/quickbooks";
import { db } from "../db";
import type { PayoutReconciliation } from "../generated/prisma/client";
import type { MirrorPayout, PayoutMirror } from "../contract";
import { getIncomeConfig, type IncomePosting } from "../runtime";
import { buildDepositLines } from "./deposit-lines";
import { toQbDeposit } from "./qb-deposits";
import {
  RECON_KIND,
  RECON_ORIGIN,
  RECON_RESOLUTION,
  RECON_STATUS,
  audit,
  incomeKey,
  lockReconciliation,
  matchWindow,
  runReconcile,
  type ReconcileResult,
} from "./reconcile";

// ponytail: fixed cap so one cron step stays short; the rest post on the next run.
export const MAX_POSTS_PER_RUN = 25;

/** What one payout's turn through the outbox did. */
export type PostOutcome = "posted" | "matched" | "queued" | "failed" | "waiting";

export type PostCounts = Record<PostOutcome, number>;

export interface DrainResult {
  reconcile: ReconcileResult;
  post: PostCounts | "unbound" | "busy";
}

const isPostable = (r: Pick<PayoutReconciliation, "status" | "kind">) =>
  r.status === RECON_STATUS.WAITING || (r.status === RECON_STATUS.OPEN && r.kind === RECON_KIND.POST_FAILED);

/** Audit actions that tie a payout to a deposit by matching, automatic or by finance. */
const MATCH_ACTIONS = ["reconciliation.matched", "reconciliation.matched_manually"];

/**
 * The takeover line: the payout date of the newest hand match ever recorded. Read from the
 * append-only audit log, so a later DRIFT or reopen never moves the line backwards.
 */
export async function incomeTakeoverLine(orgId: string): Promise<string | null> {
  const events = await db.incomeAuditLog.findMany({
    where: { orgId, entityType: "payout_reconciliation", action: { in: MATCH_ACTIONS } },
    select: { after: true },
  });
  return takeoverLine(
    events.map((e) => {
      const after = JSON.parse(e.after ?? "{}") as Partial<Pick<PayoutReconciliation, "payoutDate" | "origin">>;
      if (typeof after.payoutDate !== "string") throw new Error("match audit event has no payoutDate");
      return { date: after.payoutDate, qbOrigin: after.origin === RECON_ORIGIN.MATCHED ? "hand" : "app" };
    }),
  );
}

/** The deposit income would create for a payout: its lines split by bucket Class, summing to the payout net. */
async function depositWrite(
  orgId: string,
  payout: MirrorPayout,
  payoutDate: string,
  mirror: PayoutMirror,
  posting: IncomePosting,
): Promise<TxnWrite> {
  const txns = await mirror.transactions(payout.payoutGid);
  const orderGids = [...new Set(txns.flatMap((t) => (t.orderGid ? [t.orderGid] : [])))];
  const orderLines = orderGids.length ? await mirror.orderLines(orderGids) : [];
  const variantIds = [...new Set(orderLines.flatMap((l) => (l.variantId ? [l.variantId] : [])))];
  const mapped = await db.incomeItemCategory.findMany({ where: { orgId, variantId: { in: variantIds } } });
  const lines = buildDepositLines({
    payoutNetCents: payout.netCents,
    txns,
    orderLines,
    categories: new Map(mapped.map((m) => [m.variantId, m.budgetOwnerId])),
  });

  const buckets = new Map(lines.some((l) => l.budgetOwnerId !== null) ? (await getIncomeConfig().owners?.list() ?? []).map((o) => [o.id, o]) : []);
  const { accounts } = posting;
  return {
    entity: "Deposit",
    fields: {
      txnDate: payoutDate,
      depositToAccountId: accounts.bank,
      memo: "Shopify payout",
      lines: lines.map((l): WriteLine => {
        if (l.budgetOwnerId === null) return { amountCents: l.amountCents, accountId: accounts[l.account] };
        const bucket = buckets.get(l.budgetOwnerId);
        if (!bucket) throw new Error(`bucket ${l.budgetOwnerId} is not in the owner directory`);
        if (bucket.archivedAt) throw new Error(`bucket ${l.budgetOwnerId} is archived`);
        if (!bucket.quickBooksClassId) throw new Error(`bucket ${l.budgetOwnerId} has no QuickBooks Class`);
        return { amountCents: l.amountCents, accountId: accounts[l.account], classId: bucket.quickBooksClassId };
      }),
    },
  };
}

/**
 * One payout's turn through the outbox: match before create via findOrCreate, then record
 * the outcome. found → link (POSTED when it carries the payout's key); created → POSTED;
 * ambiguous → finance's queue; failed → POST_FAILED; too old or no line → left as it is.
 * Returns null when another holder has the lock and `wait` is off.
 */
export async function postPayout(
  orgId: string,
  id: number,
  line: string | null,
  wait: boolean,
): Promise<{ outcome: PostOutcome; row: PayoutReconciliation } | null> {
  const { mirror, posting } = getIncomeConfig();
  if (!mirror || !posting) throw new Error("income posting is not bound");
  const row = await db.payoutReconciliation.findUniqueOrThrow({ where: { id } });
  const payout = await mirror.payout(row.payoutGid);
  // A payout that is no longer paid at the net it was queued with is never booked.
  if (!isPostable(row) || payout?.status !== "paid" || payout.netCents !== row.payoutNetCents) {
    return { outcome: "waiting", row };
  }

  const window = matchWindow(row.payoutDate);
  let write: TxnWrite | null = null;
  let buildError = "";
  try {
    write = await depositWrite(orgId, payout, row.payoutDate, mirror, posting);
  } catch (e) {
    buildError = e instanceof Error ? e.message : String(e);
  }

  return db.$transaction(
    async (tx) => {
      if (!(await lockReconciliation(tx, orgId, wait))) return null;
      const current = await tx.payoutReconciliation.findUniqueOrThrow({ where: { id } });
      if (!isPostable(current)) return { outcome: "waiting" as const, row: current };

      const [held, excluded] = await Promise.all([
        tx.payoutReconciliation.findMany({ where: { orgId, depositId: { not: null } }, select: { depositId: true } }),
        tx.incomeQbMatchExclusion.findMany({ where: { orgId }, select: { qbTxnId: true } }),
      ]);
      const result: FindOrCreateResult = write
        ? await findOrCreate(posting.client, {
            write,
            key: incomeKey(current.payoutGid),
            window,
            takeoverLine: line,
            claimedIds: new Set(held.flatMap((h) => (h.depositId ? [h.depositId] : []))),
            excludedIds: new Set(excluded.map((e) => e.qbTxnId)),
          })
        : { kind: "failed", error: buildError };

      const settle = async (outcome: PostOutcome, action: string, data: Partial<PayoutReconciliation>, reason?: string) => {
        const saved = await tx.payoutReconciliation.update({ where: { id }, data });
        await audit(tx, orgId, action, current, saved, { userId: null, reason });
        return { outcome, row: saved };
      };
      const holding = async (depositId: string, origin: string) => {
        const [d] = (await posting.client.depositsBetween(window.from, window.to)).filter((x) => x.Id === depositId).map(toQbDeposit);
        if (!d) throw new Error(`deposit ${depositId} is not in the payout's window`);
        return {
          status: origin === RECON_ORIGIN.CREATED ? RECON_STATUS.POSTED : RECON_STATUS.MATCHED,
          kind: null,
          resolution: RECON_RESOLUTION.AUTO,
          origin,
          depositId: d.id,
          depositTxnDate: d.txnDate,
          depositTotalCents: d.totalCents,
        };
      };

      switch (result.kind) {
        case "created":
          return settle("posted", "reconciliation.posted", {
            status: RECON_STATUS.POSTED,
            kind: null,
            resolution: RECON_RESOLUTION.AUTO,
            origin: RECON_ORIGIN.CREATED,
            depositId: result.id,
            depositTxnDate: write?.fields.txnDate ?? null,
            depositTotalCents: current.payoutNetCents,
          });
        case "found":
          return result.via === "key"
            ? settle("posted", "reconciliation.posted", await holding(result.id, RECON_ORIGIN.CREATED))
            : settle("matched", "reconciliation.matched", await holding(result.id, RECON_ORIGIN.MATCHED));
        case "ambiguous":
          return settle("queued", "reconciliation.opened", { status: RECON_STATUS.OPEN, kind: RECON_KIND.AMBIGUOUS_DEPOSIT });
        case "failed":
          if (current.kind === RECON_KIND.POST_FAILED) return { outcome: "failed" as const, row: current };
          return settle("failed", "reconciliation.post_failed", { status: RECON_STATUS.OPEN, kind: RECON_KIND.POST_FAILED }, result.error);
        case "too-old":
        case "no-line":
          return { outcome: "waiting" as const, row: current };
      }
    },
    // Two QuickBooks requests, each with a 30s timeout and one Retry-After wait.
    { timeout: 90_000 },
  );
}

/**
 * The income cron step: match every paid payout, then post the outbox (WAITING and
 * POST_FAILED rows), at most MAX_POSTS_PER_RUN per run. The host calls it in a try/catch;
 * it returns counts only.
 */
export async function drainIncomeOutbox(orgId: string, now: Date = new Date()): Promise<DrainResult> {
  const reconcile = await runReconcile(orgId, now);
  if (reconcile.status !== "ran") return { reconcile, post: reconcile.status };
  const { mirror, posting } = getIncomeConfig();
  if (!mirror || !posting) return { reconcile, post: "unbound" };

  const line = await incomeTakeoverLine(orgId);
  const due = await db.payoutReconciliation.findMany({
    where: {
      orgId,
      OR: [{ status: RECON_STATUS.WAITING }, { status: RECON_STATUS.OPEN, kind: RECON_KIND.POST_FAILED }],
    },
    orderBy: [{ payoutDate: "asc" }, { id: "asc" }],
    select: { id: true },
  });

  const post: PostCounts = { posted: 0, matched: 0, queued: 0, failed: 0, waiting: 0 };
  let creates = 0;
  for (const { id } of due) {
    if (creates >= MAX_POSTS_PER_RUN) break;
    const turn = await postPayout(orgId, id, line, false);
    if (!turn) return { reconcile, post: "busy" };
    post[turn.outcome]++;
    if (turn.outcome === "posted" || turn.outcome === "failed") creates++;
  }
  return { reconcile, post };
}
