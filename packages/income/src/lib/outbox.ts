import { findOrCreate, qboDate, type FindOrCreateResult, type TxnWrite, type WriteLine } from "@checkin/quickbooks";
import { db } from "../db";
import type { PayoutReconciliation } from "../generated/prisma/client";
import type { MirrorBalanceTxn, MirrorOrderLine, MirrorPayout, PayoutMirror } from "../contract";
import { getIncomeConfig, isoDay, type IncomePosting } from "../runtime";
import { readIncomeSettings } from "../services/settingsService";
import { bucketProblems, checkBuckets, type BucketProblem } from "./buckets";
import { buildDepositLines } from "./deposit-lines";
import { toQbDeposit } from "./qb-deposits";
import {
  RECON_KIND,
  RECON_ORIGIN,
  RECON_RESOLUTION,
  RECON_STATUS,
  addDays,
  audit,
  incomeKey,
  lockReconciliation,
  matchWindow,
  otherLaneClaims,
  runReconcile,
  windowDays,
  type ReconcileResult,
} from "./reconcile";

/** What one payout's turn through the outbox did. */
export type PostOutcome = "posted" | "matched" | "queued" | "failed" | "waiting" | "over_cap" | "held";

export type PostCounts = Record<PostOutcome, number> & {
  /** The cap that stopped this drain with payouts still due, if one did. */
  capped: "count" | "cents" | null;
};

export interface DrainResult {
  reconcile: ReconcileResult;
  /**
   * "unbound": posting or the finance alert is not bound. "gated": the mirror is not declared
   * newest-wins. Either way nothing is created.
   */
  post: PostCounts | "unbound" | "gated" | "busy";
}

/** WAITING and NEEDS_MAPPING rows are the drain's; POST_FAILED and OVER_CAP rows move only on finance's retry. */
export const isPostable = (r: Pick<PayoutReconciliation, "status" | "kind">) =>
  r.status === RECON_STATUS.WAITING ||
  (r.status === RECON_STATUS.OPEN &&
    (r.kind === RECON_KIND.POST_FAILED || r.kind === RECON_KIND.OVER_CAP || r.kind === RECON_KIND.NEEDS_MAPPING));

const isHeld = (r: Pick<PayoutReconciliation, "status" | "kind">) =>
  r.status === RECON_STATUS.OPEN && r.kind === RECON_KIND.NEEDS_MAPPING;

type RowActor = { userId: number | null; username?: string; correlationId?: string };

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
  let line: string | null = null;
  for (const e of events) {
    const after = JSON.parse(e.after ?? "{}") as Partial<Pick<PayoutReconciliation, "payoutDate" | "origin">>;
    if (typeof after.payoutDate !== "string") throw new Error("match audit event has no payoutDate");
    qboDate(after.payoutDate);
    if (after.origin === RECON_ORIGIN.MATCHED && (line === null || after.payoutDate > line)) line = after.payoutDate;
  }
  return line;
}

/** A payout's sales: its transactions, their order lines, and finance's decision for each item that has one. */
interface PayoutSales {
  txns: MirrorBalanceTxn[];
  orderLines: MirrorOrderLine[];
  /** variantId → bucket id, or null for general income. An item with no entry is undecided. */
  categories: Map<string, number | null>;
}

async function payoutSales(orgId: string, payoutGid: string, mirror: PayoutMirror): Promise<PayoutSales> {
  const txns = await mirror.transactions(payoutGid);
  const orderGids = [...new Set(txns.flatMap((t) => (t.orderGid ? [t.orderGid] : [])))];
  const orderLines = orderGids.length ? await mirror.orderLines(orderGids) : [];
  const variantIds = [...new Set(orderLines.flatMap((l) => (l.variantId ? [l.variantId] : [])))];
  const mapped = await db.incomeItemCategory.findMany({ where: { orgId, variantId: { in: variantIds } } });
  return { txns, orderLines, categories: new Map(mapped.map((m) => [m.variantId, m.budgetOwnerId])) };
}

/**
 * Why a payout's deposit can't be built yet, naming its undecided items and unusable buckets,
 * or null when every sale has a usable decision. Custom items carry no variant and book as
 * general income.
 */
export function mappingGap(sales: PayoutSales, problem: BucketProblem): string | null {
  const undecided = new Set<string>();
  const broken = new Map<number, string>();
  for (const l of sales.orderLines) {
    if (!l.variantId) continue;
    if (!sales.categories.has(l.variantId)) {
      undecided.add(l.variantId);
      continue;
    }
    const bucket = sales.categories.get(l.variantId);
    const issue = bucket == null ? undefined : problem(bucket);
    if (bucket != null && issue) broken.set(bucket, issue);
  }
  const parts = [
    ...(undecided.size ? [`undecided items: ${[...undecided].sort().join(", ")}`] : []),
    ...[...broken].sort(([a], [b]) => a - b).map(([id, issue]) => `bucket ${id} ${issue}`),
  ];
  return parts.length ? parts.join("; ") : null;
}

/** Move a row under the lock when `from` still holds for it; otherwise return it unchanged. Null when busy. */
async function moveRow(
  orgId: string,
  id: number,
  wait: boolean,
  from: (r: PayoutReconciliation) => boolean,
  data: Partial<PayoutReconciliation>,
  action: string,
  actor: RowActor & { reason?: string },
): Promise<PayoutReconciliation | null> {
  return db.$transaction(async (tx) => {
    if (!(await lockReconciliation(tx, orgId, wait))) return null;
    const current = await tx.payoutReconciliation.findUniqueOrThrow({ where: { id } });
    if (!from(current)) return current;
    const saved = await tx.payoutReconciliation.update({ where: { id }, data });
    await audit(tx, orgId, action, current, saved, actor);
    return saved;
  });
}

/** The outcome a row that holds, or was left as it was, reports. */
const heldOutcome = (row: PayoutReconciliation) => ({ outcome: isHeld(row) ? ("held" as const) : ("waiting" as const), row });

/** Hold a payout as NEEDS_MAPPING, naming the gap. A row already held for the same gap is left as it is. */
function holdForMapping(orgId: string, id: number, gap: string, wait: boolean, actor: RowActor = { userId: null }) {
  return moveRow(
    orgId,
    id,
    wait,
    (r) => isPostable(r) && !(isHeld(r) && r.reason === gap),
    { status: RECON_STATUS.OPEN, kind: RECON_KIND.NEEDS_MAPPING, reason: gap },
    "reconciliation.needs_mapping",
    { ...actor, reason: gap },
  );
}

/** The deposit income would create for a payout: its lines split by bucket Class, summing to the payout net. */
async function depositWrite(payout: MirrorPayout, payoutDate: string, sales: PayoutSales, posting: IncomePosting): Promise<TxnWrite> {
  const lines = buildDepositLines({ payoutNetCents: payout.netCents, ...sales });

  const buckets = new Map(lines.some((l) => l.budgetOwnerId !== null) ? (await getIncomeConfig().owners?.list() ?? []).map((o) => [o.id, o]) : []);
  const { accounts } = posting;
  const bank = getIncomeConfig().bankAccountId;
  if (!bank) throw new Error("the bank account is not configured");
  return {
    entity: "Deposit",
    fields: {
      txnDate: payoutDate,
      depositToAccountId: bank,
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
 * ambiguous → finance's queue; failed → POST_FAILED; on or before the line, covered by the
 * QuickBooks books closing date (or refused as fault 6210), or with no line → left as it is.
 * Returns null when another holder has the lock and `wait` is off. `problem` and `sales` are
 * the drain's own reads, read here when absent.
 */
export async function postPayout(
  orgId: string,
  id: number,
  line: string | null,
  wait: boolean,
  opts: { actor?: RowActor; problem?: BucketProblem; sales?: PayoutSales } = {},
): Promise<{ outcome: PostOutcome; row: PayoutReconciliation } | null> {
  const actor = opts.actor ?? { userId: null };
  const { mirror, posting } = getIncomeConfig();
  if (!mirror || !posting?.mirrorNewestWins) throw new Error("income posting is not enabled");
  const row = await db.payoutReconciliation.findUniqueOrThrow({ where: { id } });
  const payout = await mirror.payout(row.payoutGid);
  // Booked only from an API row still paid at the net it was queued with; loaded history never.
  if (
    !isPostable(row) ||
    payout?.status !== "paid" ||
    payout.source !== "api" ||
    payout.netCents !== row.payoutNetCents
  ) {
    return { outcome: "waiting", row };
  }

  const sales = opts.sales ?? (await payoutSales(orgId, payout.payoutGid, mirror));
  if (line !== null && row.payoutDate > line) {
    // Only a payout the app would create waits for finance's decisions.
    const gap = mappingGap(sales, opts.problem ?? (await bucketProblems(orgId)));
    if (gap) {
      const held = await holdForMapping(orgId, id, gap, wait, actor);
      return held && heldOutcome(held);
    }
  } else if (isHeld(row)) {
    // On or before the line the app never creates, so a held payout goes back to the match window.
    const released = await moveRow(
      orgId,
      id,
      wait,
      isHeld,
      { status: RECON_STATUS.WAITING, kind: null, reason: null },
      "reconciliation.released",
      { ...actor, reason: "on or before the takeover line" },
    );
    return released && { outcome: "waiting", row: released };
  }

  const window = matchWindow(row.payoutDate);
  let write: TxnWrite | null = null;
  let buildError = "";
  try {
    write = await depositWrite(payout, row.payoutDate, sales, posting);
  } catch (e) {
    buildError = e instanceof Error ? e.message : String(e);
  }

  const foreign = await otherLaneClaims(orgId);
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
            // With no line, a closed date before the payout's own makes every miss needs-finance.
            closedThrough: line ?? addDays(write.fields.txnDate, -1),
            mayCreate: line !== null,
            claimedIds: new Set([...foreign, ...held.flatMap((h) => (h.depositId ? [h.depositId] : []))]),
            excludedIds: new Set(excluded.map((e) => e.qbTxnId)),
          })
        : { kind: "failed", error: buildError };

      const settle = async (outcome: PostOutcome, action: string, data: Partial<PayoutReconciliation>, reason?: string) => {
        const saved = await tx.payoutReconciliation.update({ where: { id }, data: isHeld(current) ? { ...data, reason: null } : data });
        await audit(tx, orgId, action, current, saved, { ...actor, reason });
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
        case "closed":
        case "needs-finance":
          return { outcome: "waiting" as const, row: current };
      }
    },
    // Covers the window read, closing-date read and create at their usual speed. A 429 retry or a paged
    // window can overrun it; the rollback leaves the payout WAITING, and the next drain finds an
    // applied create by its key.
    { timeout: 135_000 },
  );
}

/** Park a payout larger than the per-run cents cap for finance; it is never auto-created. */
async function parkOverCap(orgId: string, id: number, netCents: number, maxCents: number): Promise<boolean> {
  const parked = await moveRow(
    orgId,
    id,
    false,
    (r) => r.status === RECON_STATUS.WAITING || isHeld(r),
    { status: RECON_STATUS.OPEN, kind: RECON_KIND.OVER_CAP, reason: null },
    "reconciliation.over_cap",
    { userId: null, reason: `net ${netCents} cents is over the per-run cap of ${maxCents}` },
  );
  return parked !== null;
}

/**
 * The income cron step: match every paid payout, check every assigned bucket (alerting finance
 * once per bucket that has become unusable), then post the outbox's WAITING rows still inside
 * their match window and every NEEDS_MAPPING row, oldest first. A payout after the line with an
 * undecided item or unusable bucket holds as NEEDS_MAPPING until finance decides. Creates stop at the org's count and cents caps,
 * which fire the finance alert; failures and amount matches do not count. The host calls it in a
 * try/catch; it returns counts only.
 */
export async function drainIncomeOutbox(orgId: string, now: Date = new Date()): Promise<DrainResult> {
  const reconcile = await runReconcile(orgId, now);
  if (reconcile.status !== "ran") return { reconcile, post: reconcile.status };
  const { mirror, posting, alerts } = getIncomeConfig();
  // A cap hit must reach finance, so the drain never creates without the alert bound.
  if (!mirror || !posting || !alerts) return { reconcile, post: "unbound" };
  if (!posting.mirrorNewestWins) return { reconcile, post: "gated" };

  const problem = await checkBuckets(orgId);
  const line = await incomeTakeoverLine(orgId);
  const caps = await readIncomeSettings(db, orgId);
  const today = isoDay(now);
  const due = (
    await db.payoutReconciliation.findMany({
      where: {
        orgId,
        OR: [{ status: RECON_STATUS.WAITING }, { status: RECON_STATUS.OPEN, kind: RECON_KIND.NEEDS_MAPPING }],
      },
      orderBy: [{ payoutDate: "asc" }, { id: "asc" }],
      select: { id: true, payoutGid: true, payoutDate: true, payoutNetCents: true, status: true, kind: true },
    })
  ).filter((r) => isHeld(r) || today <= addDays(r.payoutDate, windowDays()));

  const post: PostCounts = { posted: 0, matched: 0, queued: 0, failed: 0, waiting: 0, over_cap: 0, held: 0, capped: null };
  let createdCents = 0;
  const alert = (cap: "count" | "cents", remaining: number) =>
    alerts.postCapReached({ orgId, cap, created: post.posted, createdCents, remaining });

  for (const [i, r] of due.entries()) {
    const cents = Math.abs(r.payoutNetCents);
    let sales: PayoutSales | undefined;
    // Only a payout after the line can be created, so only it is held to the caps.
    if (line !== null && r.payoutDate > line) {
      // The mapping check comes before the caps so a held payout keeps its reason.
      sales = await payoutSales(orgId, r.payoutGid, mirror);
      const gap = mappingGap(sales, problem);
      if (gap) {
        const held = await holdForMapping(orgId, r.id, gap, false);
        if (!held) return { reconcile, post: "busy" };
        post[heldOutcome(held).outcome]++;
        continue;
      }
      if (cents > caps.maxCreateCentsPerRun) {
        if (!(await parkOverCap(orgId, r.id, r.payoutNetCents, caps.maxCreateCentsPerRun))) return { reconcile, post: "busy" };
        post.over_cap++;
        await alert("cents", 1);
        continue;
      }
      if (post.posted >= caps.maxCreatesPerRun || createdCents + cents > caps.maxCreateCentsPerRun) {
        post.capped = post.posted >= caps.maxCreatesPerRun ? "count" : "cents";
        await alert(post.capped, due.length - i);
        break;
      }
    }
    const turn = await postPayout(orgId, r.id, line, false, { problem, sales });
    if (!turn) return { reconcile, post: "busy" };
    post[turn.outcome]++;
    if (turn.outcome === "posted") createdCents += cents;
  }
  return { reconcile, post };
}
