import { appKeyOf, findOrCreate, type FindOrCreateResult, type QuickBooksClient, type TxnWrite, type WriteLine } from "@checkin/quickbooks";
import { db, isUniqueConstraintError } from "../db";
import type { PayoutReconciliation } from "../generated/prisma/client";
import type { MirrorBalanceTxn, MirrorOrderLine, MirrorPayout, PayoutMirror, QbDeposit } from "../contract";
import { getIncomeConfig, incomeRuntime, isoDay, type IncomePosting } from "../runtime";
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
  isClaimed,
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
   * newest-wins. "unreadable": the books closing date could not be read. Nothing is created.
   */
  post: PostCounts | "unbound" | "gated" | "busy" | "unreadable";
}

/** WAITING and NEEDS_MAPPING rows are the drain's; POST_FAILED and OVER_CAP rows move only on finance's retry. */
export const isPostable = (r: Pick<PayoutReconciliation, "status" | "kind">) =>
  r.status === RECON_STATUS.WAITING ||
  (r.status === RECON_STATUS.OPEN &&
    (r.kind === RECON_KIND.POST_FAILED || r.kind === RECON_KIND.OVER_CAP || r.kind === RECON_KIND.NEEDS_MAPPING));

const isHeld = (r: Pick<PayoutReconciliation, "status" | "kind">) =>
  r.status === RECON_STATUS.OPEN && r.kind === RECON_KIND.NEEDS_MAPPING;

type RowActor = { userId: number | null; username?: string; correlationId?: string };

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
    if (!from(current) || isClaimed(current)) return current;
    const saved = await tx.payoutReconciliation.update({ where: { id }, data });
    await audit(tx, orgId, action, current, saved, actor);
    return saved;
  });
}

/** The outcome a row that holds, or was left as it was, reports. */
const heldOutcome = (row: PayoutReconciliation) => ({ outcome: isHeld(row) ? ("held" as const) : ("waiting" as const), row });

/** Hold a payout as NEEDS_MAPPING, naming the gap. A row already held for the same gap is left as it is. */
function holdForMapping(
  orgId: string,
  id: number,
  gap: string,
  wait: boolean,
  actor: RowActor = { userId: null },
  postable: (r: PayoutReconciliation) => boolean = isPostable,
) {
  return moveRow(
    orgId,
    id,
    wait,
    (r) => postable(r) && !(isHeld(r) && r.reason === gap),
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

/** What the closed-books gate lets one post do. */
export interface PostGate {
  /** The last closed date, YYYY-MM-DD: nothing dated on or before it is created. */
  closedThrough: string;
  /** True when the app may create the payout's deposit without asking finance. */
  mayCreate: boolean;
}

/** The queue note on a payout whose deposit would land in closed books. */
export const CLOSED_NOTE = "dated in closed books in QuickBooks; it can only be matched or skipped";

/** What the created-since lookup found for a payout whose create may already have landed. */
export type OwnEntry =
  | { kind: "none" }
  | { kind: "found"; deposit: QbDeposit }
  | { kind: "held"; note: string }
  | { kind: "unsure"; note: string };

/**
 * Look for the deposit the app created for an attempted payout: every deposit QuickBooks
 * created since the first attempt, kept when its memo carries the payout's key. Throws when
 * the read fails.
 */
export async function ownEntry(
  client: QuickBooksClient,
  orgId: string,
  row: Pick<PayoutReconciliation, "id" | "payoutGid">,
  since: Date,
): Promise<OwnEntry> {
  const { entries, full } = await client.createdSince("Deposit", since);
  const key = incomeKey(row.payoutGid);
  const keyed = entries.filter((e) => appKeyOf(e) === key);
  if (full) return { kind: "unsure", note: "the app may already have booked this payout: QuickBooks returned a full page of new deposits" };
  if (keyed.length > 1) return { kind: "unsure", note: `the app may already have booked this payout: deposits ${keyed.map((e) => e.Id).join(", ")} carry its key` };
  if (!keyed.length) return { kind: "none" };
  const holder = await db.payoutReconciliation.findUnique({ where: { orgId_depositId: { orgId, depositId: keyed[0].Id } }, select: { id: true } });
  if (holder && holder.id !== row.id) return { kind: "held", note: `app entry ${keyed[0].Id} is held by payout ${holder.id}` };
  return { kind: "found", deposit: toQbDeposit(keyed[0]) };
}

type PostResult = FindOrCreateResult | { kind: "own"; deposit: QbDeposit } | { kind: "conflict"; note: string };

/** A deposit the post saw, held as created (its key) or matched. */
function holdingData(d: QbDeposit, origin: string): Partial<PayoutReconciliation> {
  return {
    status: origin === RECON_ORIGIN.CREATED ? RECON_STATUS.POSTED : RECON_STATUS.MATCHED,
    kind: null,
    resolution: RECON_RESOLUTION.AUTO,
    origin,
    reason: null,
    qbNote: null,
    depositId: d.id,
    depositTxnDate: d.txnDate,
    depositTotalCents: d.totalCents,
  };
}

/**
 * One payout's turn through the outbox, in three steps. Claim: a short transaction marks the
 * payout as being posted and stamps its first attempt. Call, outside any transaction: an
 * attempted payout first looks for its own deposit by key; otherwise findOrCreate matches,
 * then creates when `gate` allows. Settle: a new transaction saves the result only while the
 * claim is still this post's. found → link (POSTED when it carries the payout's key);
 * created → POSTED; ambiguous or a lookup conflict → finance's queue; failed → POST_FAILED;
 * closed or needs-finance → NO_DEPOSIT, finance books it or skips it. A payout with an
 * undecided item or unusable bucket holds as NEEDS_MAPPING first. Returns null when another
 * holder has the reconcile lock and `wait` is off. `book` admits a NO_DEPOSIT payout.
 */
export async function postPayout(
  orgId: string,
  id: number,
  gate: PostGate,
  wait: boolean,
  opts: { actor?: RowActor; problem?: BucketProblem; sales?: PayoutSales; book?: boolean } = {},
): Promise<{ outcome: PostOutcome; row: PayoutReconciliation } | null> {
  const actor = opts.actor ?? { userId: null };
  const { mirror, posting } = getIncomeConfig();
  if (!mirror || !posting?.mirrorNewestWins) throw new Error("income posting is not enabled");
  const postable = (r: PayoutReconciliation) =>
    isPostable(r) || (!!opts.book && r.status === RECON_STATUS.OPEN && r.kind === RECON_KIND.NO_DEPOSIT);
  const row = await db.payoutReconciliation.findUniqueOrThrow({ where: { id } });
  const payout = await mirror.payout(row.payoutGid);
  // Booked only from an API row still paid at the net it was queued with; loaded history never.
  if (
    !postable(row) ||
    payout?.status !== "paid" ||
    payout.source !== "api" ||
    payout.netCents !== row.payoutNetCents
  ) {
    return { outcome: "waiting", row };
  }

  const sales = opts.sales ?? (await payoutSales(orgId, payout.payoutGid, mirror));
  const gap = mappingGap(sales, opts.problem ?? (await bucketProblems(orgId)));
  if (gap) {
    const held = await holdForMapping(orgId, id, gap, wait, actor, postable);
    return held && heldOutcome(held);
  }

  const window = matchWindow(row.payoutDate);
  let write: TxnWrite | null = null;
  let buildError = "";
  try {
    write = await depositWrite(payout, row.payoutDate, sales, posting);
  } catch (e) {
    buildError = e instanceof Error ? e.message : String(e);
  }

  const claimedAt = new Date();
  const claim = await db.$transaction(async (tx) => {
    if (!(await lockReconciliation(tx, orgId, wait))) return null;
    const current = await tx.payoutReconciliation.findUniqueOrThrow({ where: { id } });
    if (!postable(current) || isClaimed(current, claimedAt.getTime())) return { row: current, attempted: undefined };
    // Finance acting on the payout answers any note it carried.
    const claimed = await tx.payoutReconciliation.update({
      where: { id },
      data: {
        postClaimedAt: claimedAt,
        qbCreateAttemptedAt: current.qbCreateAttemptedAt ?? claimedAt,
        ...(actor.userId !== null && { qbNote: null }),
      },
    });
    return { row: claimed, attempted: current.qbCreateAttemptedAt };
  });
  if (!claim) return null;
  if (claim.attempted === undefined) return { outcome: "waiting", row: claim.row };
  const claimed = claim.row;

  let result: PostResult;
  if (!write) {
    result = { kind: "failed", error: buildError };
  } else {
    let own: OwnEntry = { kind: "none" };
    if (claim.attempted) {
      try {
        own = await ownEntry(posting.client, orgId, claimed, claim.attempted);
      } catch (e) {
        own = { kind: "unsure", note: `the app may already have booked this payout; the lookup failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    if (own.kind === "found") {
      result = { kind: "own", deposit: own.deposit };
    } else if (own.kind !== "none") {
      result = { kind: "conflict", note: own.note };
    } else {
      const [foreign, held, excluded] = await Promise.all([
        otherLaneClaims(orgId),
        db.payoutReconciliation.findMany({ where: { orgId, depositId: { not: null } }, select: { depositId: true } }),
        db.incomeQbMatchExclusion.findMany({ where: { orgId }, select: { qbTxnId: true } }),
      ]);
      result = await findOrCreate(posting.client, {
        write,
        key: incomeKey(claimed.payoutGid),
        window,
        closedThrough: gate.closedThrough,
        mayCreate: gate.mayCreate,
        claimedIds: new Set([...foreign, ...held.flatMap((h) => (h.depositId ? [h.depositId] : []))]),
        excludedIds: new Set(excluded.map((e) => e.qbTxnId)),
      });
    }
  }

  // The window read for a found deposit runs before the settle transaction opens.
  let found: QbDeposit | null = null;
  if (result.kind === "found") {
    const foundId = result.id;
    [found] = (await posting.client.depositsBetween(window.from, window.to)).filter((x) => x.Id === foundId).map(toQbDeposit);
    if (!found) result = { kind: "failed", error: `deposit ${foundId} is not in the payout's window` };
  }

  const settleIn = () => db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM payout_reconciliations WHERE id = ${id} FOR UPDATE`;
    const current = await tx.payoutReconciliation.findUniqueOrThrow({ where: { id } });
    if (current.postClaimedAt?.getTime() !== claimedAt.getTime()) {
      // Another post took the payout over; a deposit this one created is now finance's to void or link.
      if (result.kind !== "created") return { outcome: "waiting" as const, row: current };
      const note = `app entry ${result.id} may need voiding: its post lost the payout to another`;
      const saved = await tx.payoutReconciliation.update({ where: { id }, data: { qbNote: note } });
      await audit(tx, orgId, "reconciliation.lost_claim", current, saved, { ...actor, reason: note });
      return { outcome: "failed" as const, row: saved };
    }

    const settle = async (outcome: PostOutcome, action: string, data: Partial<PayoutReconciliation>, reason?: string) => {
      const saved = await tx.payoutReconciliation.update({ where: { id }, data: { ...data, postClaimedAt: null } });
      await audit(tx, orgId, action, current, saved, { ...actor, reason });
      return { outcome, row: saved };
    };
    const toQueue = (kind: string, note: string | null) =>
      settle("queued", "reconciliation.opened", { status: RECON_STATUS.OPEN, kind, reason: null, qbNote: note }, note ?? undefined);

    switch (result.kind) {
      case "created":
        return settle("posted", "reconciliation.posted", {
          status: RECON_STATUS.POSTED,
          kind: null,
          resolution: RECON_RESOLUTION.AUTO,
          origin: RECON_ORIGIN.CREATED,
          reason: null,
          qbNote: null,
          depositId: result.id,
          depositTxnDate: write?.fields.txnDate ?? null,
          depositTotalCents: current.payoutNetCents,
        });
      case "own":
        return settle("posted", "reconciliation.posted", holdingData(result.deposit, RECON_ORIGIN.CREATED));
      case "found":
        if (!found) throw new Error("a found deposit was not read");
        return result.via === "key"
          ? settle("posted", "reconciliation.posted", holdingData(found, RECON_ORIGIN.CREATED))
          : settle("matched", "reconciliation.matched", holdingData(found, RECON_ORIGIN.MATCHED));
      case "ambiguous":
        return toQueue(RECON_KIND.AMBIGUOUS_DEPOSIT, null);
      case "conflict":
        return toQueue(RECON_KIND.AMBIGUOUS_DEPOSIT, result.note);
      case "closed":
        return toQueue(RECON_KIND.NO_DEPOSIT, CLOSED_NOTE);
      case "needs-finance":
        return toQueue(RECON_KIND.NO_DEPOSIT, null);
      case "failed":
        if (current.kind === RECON_KIND.POST_FAILED) {
          return { outcome: "failed" as const, row: await tx.payoutReconciliation.update({ where: { id }, data: { postClaimedAt: null } }) };
        }
        return settle("failed", "reconciliation.post_failed", { status: RECON_STATUS.OPEN, kind: RECON_KIND.POST_FAILED, reason: null }, result.error);
    }
  });

  try {
    return await settleIn();
  } catch (e) {
    // Another payout settled onto the same deposit first: finance decides, nothing more is booked.
    const depositId = result.kind === "own" ? result.deposit.id : result.kind === "found" || result.kind === "created" ? result.id : null;
    if (!isUniqueConstraintError(e) || depositId === null) throw e;
    const holder = await db.payoutReconciliation.findUnique({ where: { orgId_depositId: { orgId, depositId } }, select: { id: true } });
    result = { kind: "conflict", note: `deposit ${depositId} is already held by payout ${holder?.id ?? "unknown"}` };
    return settleIn();
  }
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

/** Stamp income's switch-on the first time a connected drain runs; a set stamp never moves. */
async function switchOn(orgId: string, now: Date): Promise<Date> {
  await db.incomeOrgSettings.upsert({ where: { orgId }, create: { orgId }, update: {} });
  // Set only while null, in one statement, so overlapping runs never move it.
  await db.incomeOrgSettings.updateMany({ where: { orgId, qbPostingOnAt: null }, data: { qbPostingOnAt: now } });
  const { qbPostingOnAt } = await db.incomeOrgSettings.findUniqueOrThrow({ where: { orgId }, select: { qbPostingOnAt: true } });
  if (!qbPostingOnAt) throw new Error("income switch-on was not recorded");
  return qbPostingOnAt;
}

/**
 * The last closed date: QuickBooks' books closing date, or the day before switch-on when none
 * is set. Null when neither exists, so nothing may be created.
 */
export function closedThroughOf(closeDate: string | null, onAt: Date | null): string | null {
  return closeDate ?? (onAt ? addDays(isoDay(onAt), -1) : null);
}

/**
 * The income cron step: match every paid payout, stamp switch-on, read the books closing date,
 * check every assigned bucket (alerting finance once per bucket that has become unusable), then
 * post the outbox's WAITING rows and every NEEDS_MAPPING row, oldest first. A payout first seen
 * after switch-on books itself, however late it arrived; one seen before waits out its match
 * window and then goes to finance. A payout with an undecided item or unusable bucket holds as
 * NEEDS_MAPPING until finance decides. Creates stop at the org's count and cents caps, which
 * fire the finance alert; failures and amount matches do not count. The host calls it in a
 * try/catch; it returns counts only.
 */
export async function drainIncomeOutbox(orgId: string, now: Date = new Date()): Promise<DrainResult> {
  const reconcile = await runReconcile(orgId, now);
  if (reconcile.status !== "ran") return { reconcile, post: reconcile.status };
  const { mirror, posting, alerts } = getIncomeConfig();
  // A cap hit must reach finance, so the drain never creates without the alert bound.
  if (!mirror || !posting || !alerts) return { reconcile, post: "unbound" };
  if (!posting.mirrorNewestWins) return { reconcile, post: "gated" };

  // After reconcile, so every payout the mirror already holds is dated before the stamp.
  const onAt = await switchOn(orgId, now);
  let closeDate: string | null;
  try {
    closeDate = await posting.client.bookCloseDate();
  } catch {
    return { reconcile, post: "unreadable" };
  }
  const closedThrough = closeDate ?? addDays(isoDay(onAt), -1);

  const problem = await checkBuckets(orgId);
  const caps = await readIncomeSettings(db, orgId);
  const today = isoDay(now);
  const due = (
    await db.payoutReconciliation.findMany({
      where: {
        orgId,
        OR: [{ status: RECON_STATUS.WAITING }, { status: RECON_STATUS.OPEN, kind: RECON_KIND.NEEDS_MAPPING }],
      },
      orderBy: [{ payoutDate: "asc" }, { id: "asc" }],
      select: { id: true, payoutGid: true, payoutDate: true, payoutNetCents: true, status: true, kind: true, createdAt: true },
    })
  ).filter((r) => isHeld(r) || r.createdAt > onAt || today <= addDays(r.payoutDate, windowDays()));

  const post: PostCounts = { posted: 0, matched: 0, queued: 0, failed: 0, waiting: 0, over_cap: 0, held: 0, capped: null };
  let createdCents = 0;
  const alert = (cap: "count" | "cents", remaining: number) =>
    alerts.postCapReached({ orgId, cap, created: post.posted, createdCents, remaining });

  for (const [i, r] of due.entries()) {
    const cents = Math.abs(r.payoutNetCents);
    const mayCreate = r.createdAt > onAt;
    // The mapping check comes before the caps so a held payout keeps its reason.
    const sales = await payoutSales(orgId, r.payoutGid, mirror);
    const gap = mappingGap(sales, problem);
    if (gap) {
      const held = await holdForMapping(orgId, r.id, gap, false);
      if (!held) return { reconcile, post: "busy" };
      post[heldOutcome(held).outcome]++;
      continue;
    }
    // Only a payout the app may create is held to the caps.
    if (mayCreate) {
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
    const turn = await postPayout(orgId, r.id, { closedThrough, mayCreate }, false, { problem, sales });
    if (!turn) return { reconcile, post: "busy" };
    post[turn.outcome]++;
    if (turn.outcome === "posted") createdCents += cents;
  }
  return { reconcile, post };
}

/** What one orphan sweep read and reported. */
export type SweepResult = { status: "unbound" } | { status: "ran"; read: number; flagged: number; full: boolean };

/** How far back the orphan sweep looks for attempted payouts. */
export const SWEEP_DAYS = 30;

/**
 * The daily orphan sweep: one read of every deposit QuickBooks created since the oldest
 * attempt in the last SWEEP_DAYS, and a queue note on each payout whose key an entry carries
 * but which does not hold that entry. A full page alerts finance that some entries went
 * unseen. Reads QuickBooks only; finance voids or links what it reports. Unconfigured or
 * unbound, it reads nothing.
 */
export async function runIncomeOrphanSweep(orgId: string, now: Date = new Date()): Promise<SweepResult> {
  const { posting, alerts } = incomeRuntime.configured() ?? {};
  if (!posting || !alerts) return { status: "unbound" };
  const oldest = await db.payoutReconciliation.findFirst({
    where: { orgId, qbCreateAttemptedAt: { gte: new Date(now.getTime() - SWEEP_DAYS * 86_400_000) } },
    orderBy: { qbCreateAttemptedAt: "asc" },
    select: { qbCreateAttemptedAt: true },
  });
  if (!oldest?.qbCreateAttemptedAt) return { status: "ran", read: 0, flagged: 0, full: false };
  const { entries, full } = await posting.client.createdSince("Deposit", oldest.qbCreateAttemptedAt);
  if (full) await alerts.sweepIncomplete({ orgId, since: oldest.qbCreateAttemptedAt });

  const rows = await db.payoutReconciliation.findMany({ where: { orgId } });
  const byKey = new Map(rows.map((r) => [incomeKey(r.payoutGid), r]));
  let flagged = 0;
  for (const e of entries) {
    const key = appKeyOf(e);
    const row = key ? byKey.get(key) : undefined;
    if (!row || row.depositId === e.Id || isClaimed(row, now.getTime())) continue;
    const note = `app entry ${e.Id} is not linked; void or link it`;
    if (row.qbNote === note) continue;
    await db.$transaction(async (tx) => {
      const saved = await tx.payoutReconciliation.update({ where: { id: row.id }, data: { qbNote: note } });
      await audit(tx, orgId, "reconciliation.orphan_entry", row, saved, { userId: null, reason: note });
    });
    flagged++;
  }
  return { status: "ran", read: entries.length, flagged, full };
}
