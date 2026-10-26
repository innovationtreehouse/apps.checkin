import { findMatch, qbKey, type MatchCandidate } from "@checkin/quickbooks";
import { db } from "../db";
import type { PayoutReconciliation } from "../generated/prisma/client";
import type { MirrorPayout, MirrorSource, PayoutMirror, QbDeposit } from "../contract";
import { assertOrg, getIncomeConfig, isoDay } from "../runtime";
import { recordAudit, type TxClient } from "./audit";
import { depositsIn, type DayRange } from "./qb-deposits";
import { BANK_ROLE, BENEVITY_MATCH_WINDOW_DAYS, DEPOSIT_SOURCE, isBenevity, roleAccounts, rowKey, rowKeys } from "./sources";

export const RECON_STATUS = {
  WAITING: "WAITING",
  OPEN: "OPEN",
  MATCHED: "MATCHED",
  POSTED: "POSTED",
  RESOLVED: "RESOLVED",
} as const;
export type ReconStatus = (typeof RECON_STATUS)[keyof typeof RECON_STATUS];

export const RECON_KIND = {
  NO_DEPOSIT: "NO_DEPOSIT",
  AMBIGUOUS_DEPOSIT: "AMBIGUOUS_DEPOSIT",
  TXN_SUM_MISMATCH: "TXN_SUM_MISMATCH",
  DRIFT: "DRIFT",
  POST_FAILED: "POST_FAILED",
  /** Larger than the org's per-run cents cap: never auto-created; finance retries it. */
  OVER_CAP: "OVER_CAP",
  /**
   * Held: a sale's item is undecided, or its bucket is unusable. Never becomes NO_DEPOSIT;
   * each drain retries it and books it once finance closes the gap.
   */
  NEEDS_MAPPING: "NEEDS_MAPPING",
} as const;
export type ReconKind = (typeof RECON_KIND)[keyof typeof RECON_KIND];

export const RECON_RESOLUTION = { AUTO: "AUTO", MANUAL: "MANUAL", DISMISSED: "DISMISSED" } as const;

/** Where the deposit a row holds came from: found in QuickBooks, or created by income. */
export const RECON_ORIGIN = { MATCHED: "matched", CREATED: "created" } as const;

/** Statuses whose row holds a decision a later change to the payout or deposit must reopen. */
export const SETTLED_STATUSES: string[] = [RECON_STATUS.MATCHED, RECON_STATUS.POSTED, RECON_STATUS.RESOLVED];

export const DEFAULT_WINDOW_DAYS = 7;
/** A claim older than this belongs to a post that died between claim and settle; it may be taken over. */
export const CLAIM_TTL_MS = 10 * 60_000;

/** Whether a post holds this payout right now. */
export function isClaimed(row: Pick<PayoutReconciliation, "postClaimedAt">, now: number = Date.now()): boolean {
  return row.postClaimedAt !== null && now - row.postClaimedAt.getTime() <= CLAIM_TTL_MS;
}

/** The app entry a stray-entry warning names ("may need voiding", "is not linked"), or null for any other note. */
export function strayEntryOf(note: string | null): string | null {
  return /^app entry (\S+) (?:may need voiding|is not linked)/.exec(note ?? "")?.[1] ?? null;
}

/** Every app entry a note's stray-entry warnings name. */
function strayEntriesOf(note: string | null): string[] {
  return [...(note ?? "").matchAll(/app entry (\S+) (?:may need voiding|is not linked)/g)].map((m) => m[1]);
}

/** How a finance action's audit names a stray app entry it answered, under `answeredEntries`. */
export const answeredEntryRef = (entryId: string) => `Deposit:${entryId}`;

/**
 * The app note a payout carries once it holds `depositId` and adds `next`: a warning about a
 * different stray app entry stays until finance answers it; every other note is replaced.
 */
export function nextNote(current: string | null, depositId: string | null, next: string | null): string | null {
  const stray = strayEntryOf(current);
  const kept = stray && stray !== depositId ? current : null;
  return [...new Set([kept, next].filter((n): n is string => !!n))].join("; ") || null;
}

/** The queue note on an attempted payout a deposit fits by amount: its own deposit may sit outside the window. */
export const ATTEMPTED_MATCH_NOTE = "a deposit fits by amount, but the app may already have booked this payout; matching checks for the app's own deposit first";

/** When each source's posting switched on for the org; null while that source is off. */
export type SwitchOn = { shopify: Date | null; benevity: Date | null };

export async function postingOnAt(orgId: string): Promise<SwitchOn> {
  const s = await db.incomeOrgSettings.findUnique({ where: { orgId }, select: { qbPostingOnAt: true, benevityQbPostingOnAt: true } });
  return { shopify: s?.qbPostingOnAt ?? null, benevity: s?.benevityQbPostingOnAt ?? null };
}

/** One source's switch-on stamp. */
export const stampOf = (on: SwitchOn, source: string): Date | null => (source === DEPOSIT_SOURCE.BENEVITY ? on.benevity : on.shopify);
export const DEFAULT_DATE_GRACE_DAYS = 2;

/** A deposit income expects, normalised for matching: a paid mirror payout, or another lane's expected deposit. */
export interface PayoutFact {
  depositSource: string;
  payoutGid: string;
  payoutDate: string;
  netCents: number;
  sumMismatch: boolean;
  /** Where the mirror row came from; null for another lane's expected deposit. */
  source: MirrorSource | null;
}

export type ReconcileResult =
  | { status: "unbound" }
  | { status: "busy" }
  | { status: "ran"; matched: number; opened: number; drifted: number };

export function addDays(day: string, n: number): string {
  return isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));
}

/** Days after a deposit's date within which it must be booked; a Benevity deposit keeps donation's window. */
export function windowDays(source: string = DEPOSIT_SOURCE.SHOPIFY): number {
  return source === DEPOSIT_SOURCE.BENEVITY ? BENEVITY_MATCH_WINDOW_DAYS : (getIncomeConfig().windowDays ?? DEFAULT_WINDOW_DAYS);
}

/** The idempotency key of the deposit income creates for a payout. */
export function incomeKey(payoutGid: string): string {
  return qbKey("income", payoutGid);
}

/** The days a deposit may be dated: [date − grace, date + window] for a payout, ± the window for Benevity. */
export function matchWindow(payoutDate: string, source: string = DEPOSIT_SOURCE.SHOPIFY): { from: string; to: string } {
  const grace = source === DEPOSIT_SOURCE.BENEVITY ? BENEVITY_MATCH_WINDOW_DAYS : (getIncomeConfig().dateGraceDays ?? DEFAULT_DATE_GRACE_DAYS);
  return { from: addDays(payoutDate, -grace), to: addDays(payoutDate, windowDays(source)) };
}

/** A row's keys as findMatch takes them: the one income creates under, and every other its own deposit may carry. */
export function matchKeys(row: Pick<PayoutReconciliation, "orgId" | "source" | "payoutGid">): { key: string; alsoKeys: string[] } {
  const [, ...alsoKeys] = rowKeys(row);
  return { key: rowKey(row), alsoKeys };
}

export function depositMatchCandidate(d: QbDeposit): MatchCandidate {
  return { id: d.id, date: d.txnDate, amountCents: d.totalCents, ref: d.depositToAccount ?? undefined, appKey: d.appKey };
}

/**
 * Serialise every reconciliation write for an org (cron, "run now", finance actions).
 * Returns false when `wait` is off and another holder has it.
 */
export async function lockReconciliation(tx: TxClient, orgId: string, wait: boolean): Promise<boolean> {
  if (wait) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('income.reconcile'), hashtext(${orgId}))::text`;
    return true;
  }
  const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
    SELECT pg_try_advisory_xact_lock(hashtext('income.reconcile'), hashtext(${orgId})) AS locked`;
  return locked;
}

/** Deposits another lane holds; empty while that port is unbound. */
// ponytail: read-then-claim across two databases, so two lanes running at the same instant can
// still race; a shared claim table in one database closes it if the lanes ever run concurrently.
export async function otherLaneClaims(orgId: string): Promise<string[]> {
  return (await getIncomeConfig().otherLaneClaims?.claimedDepositIds(orgId)) ?? [];
}

/** Deposits income holds, for another lane to keep out of its own matching. */
export async function incomeClaimedDepositIds(orgId: string): Promise<string[]> {
  await assertOrg(orgId);
  const rows = await db.payoutReconciliation.findMany({
    where: { orgId, depositId: { not: null } },
    select: { depositId: true },
  });
  return rows.flatMap((r) => (r.depositId ? [r.depositId] : []));
}

export async function collectPayouts(mirror: PayoutMirror): Promise<PayoutFact[]> {
  const { reconcileFrom } = getIncomeConfig();
  const facts: PayoutFact[] = [];
  for (const p of await mirror.paidPayoutsSince(reconcileFrom ?? new Date(0))) {
    const txns = await mirror.transactions(p.payoutGid);
    const txnNet = txns.reduce((s, t) => s + t.netCents, 0);
    facts.push({
      depositSource: DEPOSIT_SOURCE.SHOPIFY,
      payoutGid: p.payoutGid,
      payoutDate: isoDay(p.issuedAt),
      netCents: p.netCents,
      sumMismatch: txnNet !== p.netCents,
      source: p.source,
    });
  }
  return facts.sort((a, b) => a.payoutDate.localeCompare(b.payoutDate) || a.payoutGid.localeCompare(b.payoutGid));
}

/**
 * Why a settled row must reopen, or null when its payout and deposit still agree with it. A
 * Benevity row's expected deposit is frozen once posted, so only its deposit is checked.
 */
function driftCause(
  row: PayoutReconciliation,
  payout: MirrorPayout | null,
  deposits: Map<string, QbDeposit>,
): string | null {
  if (!isBenevity(row)) {
    if (!payout) return "payout_missing";
    if (payout.status !== "paid") return `payout_status:${payout.status}`;
    if (payout.netCents !== row.payoutNetCents) return "payout_amount";
  }
  if (!row.depositId) return null;
  const d = deposits.get(row.depositId);
  if (!d) return "deposit_missing";
  if (d.totalCents !== row.depositTotalCents || d.txnDate !== row.depositTxnDate) return "deposit_changed";
  return null;
}

/**
 * Match every paid payout to exactly one QuickBooks deposit, or raise it for finance.
 * Idempotent; a no-op until a deposit source is bound. Reads the ledger only.
 */
export async function runReconcile(orgId: string, now: Date = new Date()): Promise<ReconcileResult> {
  const { deposits: depositSource, mirror } = getIncomeConfig();
  if (!depositSource) return { status: "unbound" };
  // Without its bank account a deposit in any account could match, so a source without one is not read.
  const accounts = await roleAccounts();
  const banks = { shopify: mirror ? accounts[BANK_ROLE.shopify] : undefined, benevity: accounts[BANK_ROLE.benevity] };
  if (!banks.shopify && !banks.benevity) return { status: "unbound" };
  const bankOf = (source: string) => (source === DEPOSIT_SOURCE.BENEVITY ? banks.benevity : banks.shopify);
  const sources = (Object.keys(banks) as (keyof typeof banks)[]).filter((s) => banks[s]);

  const today = isoDay(now);
  // Another lane's expected deposits are facts as income holds them; settled ones are past matching.
  const expected = await db.payoutReconciliation.findMany({
    where: { orgId, source: DEPOSIT_SOURCE.BENEVITY, status: { in: [RECON_STATUS.WAITING, RECON_STATUS.OPEN] } },
  });
  const facts = [
    ...(mirror && banks.shopify ? await collectPayouts(mirror) : []),
    ...(banks.benevity
      ? expected.map((r): PayoutFact => ({ depositSource: r.source, payoutGid: r.payoutGid, payoutDate: r.payoutDate, netCents: r.payoutNetCents, sumMismatch: false, source: null }))
      : []),
  ];

  // Settled rows are drift-checked against the payout's current state, whether or not it is
  // still paid and inside reconcileFrom. Rows settled after this read are checked next run.
  const settled = await db.payoutReconciliation.findMany({
    where: { orgId, status: { in: SETTLED_STATUSES }, source: { in: sources } },
    select: { source: true, payoutGid: true, depositTxnDate: true },
  });
  const settledPayouts = new Map<string, MirrorPayout | null>();
  for (const { source, payoutGid } of settled) {
    settledPayouts.set(payoutGid, source === DEPOSIT_SOURCE.SHOPIFY && mirror ? await mirror.payout(payoutGid) : null);
  }

  // Reads only each payout's match window and each settled deposit's booked day, never history.
  const ranges: DayRange[] = [
    ...facts.map((f): DayRange => {
      const w = matchWindow(f.payoutDate, f.depositSource);
      return [w.from, w.to];
    }),
    ...settled.flatMap((r): DayRange[] => (r.depositTxnDate ? [[r.depositTxnDate, r.depositTxnDate]] : [])),
  ];
  const deposits = await depositsIn(depositSource, ranges);
  const foreign = await otherLaneClaims(orgId);
  const switchedOn = await postingOnAt(orgId);
  const depositsById = new Map(deposits.map((d) => [d.id, d]));

  return db.$transaction(
    async (tx) => {
      if (!(await lockReconciliation(tx, orgId, false))) return { status: "busy" } as const;

      const result = { status: "ran" as const, matched: 0, opened: 0, drifted: 0 };
      const rows = await tx.payoutReconciliation.findMany({ where: { orgId } });
      const byGid = new Map(rows.map((r) => [r.payoutGid, r]));
      const claimed = new Set([...foreign, ...rows.flatMap((r) => (r.depositId ? [r.depositId] : []))]);
      const exclusions = await tx.incomeQbMatchExclusion.findMany({ where: { orgId }, select: { qbTxnId: true } });
      const excluded = new Set(exclusions.map((e) => e.qbTxnId));

      // Settled rows whose payout or deposit moved reopen for finance; never re-matched silently.
      for (const row of rows) {
        if (!SETTLED_STATUSES.includes(row.status) || !settledPayouts.has(row.payoutGid)) continue;
        const payout = settledPayouts.get(row.payoutGid) ?? null;
        const cause = driftCause(row, payout, depositsById);
        if (!cause) continue;

        if (row.depositId) claimed.delete(row.depositId);
        const updated = await tx.payoutReconciliation.update({
          where: { id: row.id },
          data: {
            status: RECON_STATUS.OPEN,
            kind: RECON_KIND.DRIFT,
            resolution: null,
            origin: null,
            depositId: null,
            depositTxnDate: null,
            depositTotalCents: null,
            payoutNetCents: payout?.netCents ?? row.payoutNetCents,
          },
        });
        byGid.set(row.payoutGid, updated);
        await audit(tx, orgId, "reconciliation.drift", row, updated, { userId: null, reason: cause });
        result.drifted++;
      }

      // The lookup is the shared findMatch with the bank account findOrCreate uses, so the two
      // never disagree. A hit on the payout's own key is a deposit income created.
      const candidates = deposits.map(depositMatchCandidate);
      for (const fact of facts) {
        const row = byGid.get(fact.payoutGid);
        const open = row?.status === RECON_STATUS.OPEN && row.kind !== RECON_KIND.DRIFT;
        if (row && row.status !== RECON_STATUS.WAITING && !open) continue;
        // A post holds this payout; its settle decides it.
        if (row && isClaimed(row, now.getTime())) continue;

        const match = fact.sumMismatch
          ? null
          : findMatch(candidates, {
              date: fact.payoutDate,
              amountCents: fact.netCents,
              ref: bankOf(fact.depositSource),
              ...matchKeys({ orgId, source: fact.depositSource, payoutGid: fact.payoutGid }),
              window: matchWindow(fact.payoutDate, fact.depositSource),
              claimedIds: claimed,
              excludedIds: excluded,
            });

        // A payout first seen after switch-on waits for the drain to create it, however late it arrived.
        const onAt = stampOf(switchedOn, fact.depositSource);
        const seenAfterOn = onAt !== null && (row ? row.createdAt > onAt : now > onAt);
        const windowElapsed = !seenAfterOn && today > addDays(fact.payoutDate, windowDays(fact.depositSource));

        // An attempted payout's own deposit may sit outside the window, so it never matches by amount
        // here: the drain's post or finance's match looks up its own deposit first.
        if (match?.kind === "found" && match.via === "amount" && row?.qbCreateAttemptedAt) {
          if (row.status === RECON_STATUS.WAITING && !windowElapsed) continue;
          if (row.status === RECON_STATUS.OPEN && row.kind === RECON_KIND.AMBIGUOUS_DEPOSIT) continue;
          const saved = await tx.payoutReconciliation.update({
            where: { id: row.id },
            data: {
              status: RECON_STATUS.OPEN,
              kind: RECON_KIND.AMBIGUOUS_DEPOSIT,
              payoutNetCents: fact.netCents,
              qbNote: nextNote(row.qbNote, null, ATTEMPTED_MATCH_NOTE),
            },
          });
          await audit(tx, orgId, "reconciliation.opened", row, saved, { userId: null, reason: ATTEMPTED_MATCH_NOTE });
          if (!open) result.opened++;
          continue;
        }

        if (match?.kind === "found") {
          const d = depositsById.get(match.id);
          if (!d) throw new Error(`matched deposit ${match.id} is not in the read`);
          const created = match.via === "key";
          const data = {
            status: created ? RECON_STATUS.POSTED : RECON_STATUS.MATCHED,
            kind: null,
            resolution: RECON_RESOLUTION.AUTO,
            origin: created ? RECON_ORIGIN.CREATED : RECON_ORIGIN.MATCHED,
            depositId: d.id,
            depositTxnDate: d.txnDate,
            depositTotalCents: d.totalCents,
            payoutNetCents: fact.netCents,
            postClaimedAt: null,
            reason: null,
            qbNote: nextNote(row?.qbNote ?? null, d.id, null),
          };
          const saved = row
            ? await tx.payoutReconciliation.update({ where: { id: row.id }, data })
            : await tx.payoutReconciliation.create({ data: { ...base(orgId, fact, now), ...data } });
          claimed.add(d.id);
          await audit(tx, orgId, created ? "reconciliation.posted" : "reconciliation.matched", row ?? null, saved);
          result.matched++;
          continue;
        }

        // A failed or over-cap create stays parked until a deposit turns up or finance retries.
        if (row?.kind === RECON_KIND.POST_FAILED || row?.kind === RECON_KIND.OVER_CAP) continue;
        // An attempted payout sent to finance as ambiguous stays there: the app may have booked it.
        if (row?.qbCreateAttemptedAt && open && row.kind === RECON_KIND.AMBIGUOUS_DEPOSIT) continue;
        // A held payout is outside the window's clock; it tracks the payout's net while it waits.
        if (row?.kind === RECON_KIND.NEEDS_MAPPING) {
          if (row.payoutNetCents === fact.netCents) continue;
          const saved = await tx.payoutReconciliation.update({ where: { id: row.id }, data: { payoutNetCents: fact.netCents } });
          await audit(tx, orgId, "reconciliation.needs_mapping", row, saved, { userId: null, reason: "payout_amount" });
          continue;
        }
        // Inside the window an unfound payout waits in the outbox for drainIncomeOutbox. An
        // ambiguous one never waits there: it goes straight to finance and is never created.
        if (!fact.sumMismatch && !windowElapsed && match?.kind !== "ambiguous") {
          if (row) continue;
          const saved = await tx.payoutReconciliation.create({
            data: { ...base(orgId, fact, now), status: RECON_STATUS.WAITING },
          });
          await audit(tx, orgId, "reconciliation.waiting", null, saved);
          continue;
        }

        const kind = fact.sumMismatch
          ? RECON_KIND.TXN_SUM_MISMATCH
          : match?.kind === "ambiguous"
            ? RECON_KIND.AMBIGUOUS_DEPOSIT
            : RECON_KIND.NO_DEPOSIT;
        if (open && row.kind === kind && row.payoutNetCents === fact.netCents) continue;

        const saved = row
          ? await tx.payoutReconciliation.update({
              where: { id: row.id },
              data: { status: RECON_STATUS.OPEN, kind, payoutNetCents: fact.netCents, postClaimedAt: null },
            })
          : await tx.payoutReconciliation.create({
              data: { ...base(orgId, fact, now), status: RECON_STATUS.OPEN, kind },
            });
        await audit(tx, orgId, "reconciliation.opened", row ?? null, saved);
        if (!open) result.opened++;
      }

      return result;
    },
    { timeout: 60_000 },
  );
}

function base(orgId: string, fact: PayoutFact, now: Date) {
  return {
    orgId,
    payoutGid: fact.payoutGid,
    payoutDate: fact.payoutDate,
    payoutNetCents: fact.netCents,
    createdAt: now,
  };
}

export function audit(
  tx: TxClient,
  orgId: string,
  action: string,
  before: PayoutReconciliation | null,
  after: PayoutReconciliation,
  actor: { userId: number | null; username?: string; reason?: string | null; correlationId?: string } = {
    userId: null,
  },
): Promise<void> {
  // A finance action that drops a stray-entry warning records the entry, so the orphan sweep never raises it again.
  const kept = strayEntriesOf(after.qbNote);
  const answered = actor.userId === null ? [] : strayEntriesOf(before?.qbNote ?? null).filter((e) => !kept.includes(e));
  return recordAudit(tx, {
    orgId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action,
    entityType: "payout_reconciliation",
    entityId: after.id,
    before: before ?? undefined,
    after: answered.length ? { ...after, answeredEntries: answered.map(answeredEntryRef) } : after,
    reason: actor.reason,
    correlationId: actor.correlationId,
  });
}
