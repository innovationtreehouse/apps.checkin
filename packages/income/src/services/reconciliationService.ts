import { db, isUniqueConstraintError } from "../db";
import { readIncomeSettings } from "./settingsService";
import type { QbDeposit } from "../contract";
import { getIncomeConfig } from "../runtime";
import {
  RECON_KIND,
  RECON_ORIGIN,
  RECON_RESOLUTION,
  RECON_STATUS,
  addDays,
  audit,
  isClaimed,
  lockReconciliation,
  matchWindow,
  postingOnAt,
  runReconcile,
  stampOf,
  windowDays,
  type ReconStatus,
} from "../lib/reconcile";
import { recordAudit, type TxClient } from "../lib/audit";
import { depositsIn } from "../lib/qb-deposits";
import { closedThroughOf, isPostable, ownEntry, postPayout, type OwnEntry } from "../lib/outbox";
import { BANK_ROLE, DEPOSIT_SOURCE, isBenevity, roleAccounts, rowKey } from "../lib/sources";
import { ServiceError } from "@checkin/component-kit";

export interface Actor {
  userId: number;
  username?: string;
  correlationId?: string;
}

/** The finance resolutions the resolve route accepts. */
export type ResolveAction =
  | { action: "match"; depositId: string; reason?: string }
  | { action: "dismiss"; reason: string }
  | { action: "retry" }
  | { action: "book" }
  | { action: "clear_note"; reason: string };

async function openRow(orgId: string, id: number) {
  const row = await db.payoutReconciliation.findUnique({ where: { id } });
  if (!row || row.orgId !== orgId) throw new ServiceError(404, "Not found");
  return row;
}

/** The bank account a row's deposits land in, from the books map. */
async function bankOf(row: { source: string }): Promise<string | undefined> {
  return (await roleAccounts())[isBenevity(row) ? BANK_ROLE.benevity : BANK_ROLE.shopify];
}

/** Deposits into the row's bank account dated within ±window of its date, read live from QuickBooks. */
async function windowDeposits(row: { orgId: string; source: string; payoutDate: string }): Promise<QbDeposit[]> {
  const { deposits: source } = getIncomeConfig();
  const bank = await bankOf(row);
  if (!source || !bank) throw new ServiceError(503, "QuickBooks is not connected");
  const w = windowDays(row.source, (await readIncomeSettings(db, row.orgId)).benevityMatchWindowDays);
  const from = addDays(row.payoutDate, -w);
  const to = addDays(row.payoutDate, w);
  return (await depositsIn(source, [[from, to]])).filter((d) => d.depositToAccount === bank);
}

/**
 * Before finance matches or dismisses a payout whose create may already have landed, look for
 * the app's own deposit. Found: the payout is linked to it and returned, and finance's action
 * is not applied. Held by another payout, or unclear: refused. Nothing found, or never
 * attempted: null, and the action goes ahead.
 */
async function ownEntryFirst(orgId: string, id: number, actor: Actor) {
  const row = await openRow(orgId, id);
  if (isClaimed(row)) throw new ServiceError(409, "The payout is being posted; try again shortly");
  // A drifted payout's attempt is the one that booked the drifted deposit; finance decides it.
  if (!row.qbCreateAttemptedAt || row.kind === RECON_KIND.DRIFT) return null;
  const { posting } = getIncomeConfig();
  if (!posting) throw new ServiceError(503, "QuickBooks is not connected");
  let own: OwnEntry;
  try {
    own = await ownEntry(posting.client, orgId, row, row.qbCreateAttemptedAt);
  } catch {
    throw new ServiceError(503, "QuickBooks could not be read to check for the app's own deposit");
  }
  if (own.kind === "none") return null;
  if (own.kind !== "found") throw new ServiceError(409, own.note);
  const d = own.deposit;
  try {
    return await db.$transaction(async (tx) => {
      await lockReconciliation(tx, orgId, true);
      const current = await tx.payoutReconciliation.findUniqueOrThrow({ where: { id } });
      if (current.status !== RECON_STATUS.OPEN || isClaimed(current)) throw new ServiceError(409, "Already resolved");
      const note = `The app had already booked this payout as deposit ${d.id}; it is linked to that deposit and your action was not applied`;
      const saved = await tx.payoutReconciliation.update({
        where: { id },
        data: {
          status: RECON_STATUS.POSTED,
          kind: null,
          resolution: RECON_RESOLUTION.AUTO,
          origin: RECON_ORIGIN.CREATED,
          qbNote: note,
          postClaimedAt: null,
          depositId: d.id,
          depositTxnDate: d.txnDate,
          depositTotalCents: d.totalCents,
        },
      });
      await audit(tx, orgId, "reconciliation.posted", current, saved, { ...actor, reason: note });
      return saved;
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new ServiceError(409, `App entry ${d.id} already backs another payout`);
    throw err;
  }
}

/** Finance's go-ahead runs the post path with the gate read now; a failed read is a 503. */
async function goAhead(orgId: string, id: number, actor: Actor, book: boolean) {
  const { mirror, posting } = getIncomeConfig();
  const row = await openRow(orgId, id);
  if (!posting || (!isBenevity(row) && (!mirror || !posting.mirrorNewestWins))) {
    throw new ServiceError(503, "QuickBooks deposit creation is not available");
  }
  let closeDate: string | null;
  try {
    closeDate = await posting.client.bookCloseDate();
  } catch {
    throw new ServiceError(503, "QuickBooks could not be read for its books closing date");
  }
  const closedThrough = closedThroughOf(closeDate, stampOf(await postingOnAt(orgId), row.source));
  if (!closedThrough) throw new ServiceError(409, "QuickBooks has no books closing date set, and income posting is not switched on");
  const turn = await postPayout(orgId, id, { closedThrough, mayCreate: true }, true, { actor, book });
  if (!turn) throw new ServiceError(409, "A reconciliation run is in progress");
  if (turn.outcome === "held") throw new ServiceError(409, `The payout is held: ${turn.row.reason ?? ""}`);
  if (book && turn.outcome === "waiting") {
    throw new ServiceError(409, "The payout is not ready to book: it is being posted, its Shopify payout changed, or a books-map role it needs has no account");
  }
  return turn.row;
}

/** Drop deposits a payout already holds, or finance excluded. */
async function unclaimed(client: TxClient, orgId: string, deposits: QbDeposit[]): Promise<QbDeposit[]> {
  const [claimed, excluded] = await Promise.all([
    client.payoutReconciliation.findMany({
      where: { orgId, depositId: { not: null } },
      select: { depositId: true },
    }),
    client.incomeQbMatchExclusion.findMany({ where: { orgId }, select: { qbTxnId: true } }),
  ]);
  const taken = new Set([...claimed.map((c) => c.depositId), ...excluded.map((e) => e.qbTxnId)]);
  return deposits.filter((d) => !taken.has(d.id));
}

/** Whether a payout the create path may still book would match this deposit, so excluding it forces a second booking. */
async function fitsPostablePayout(client: TxClient, orgId: string, qbTxnId: string): Promise<boolean> {
  const rows = (
    await client.payoutReconciliation.findMany({
      where: { orgId, status: { in: [RECON_STATUS.WAITING, RECON_STATUS.OPEN] } },
    })
  ).filter(isPostable);
  if (!rows.length) return false;
  const { deposits: source } = getIncomeConfig();
  const accounts = await roleAccounts();
  const banks = { [DEPOSIT_SOURCE.SHOPIFY]: accounts[BANK_ROLE.shopify], [DEPOSIT_SOURCE.BENEVITY]: accounts[BANK_ROLE.benevity] };
  if (!source || (!banks.shopify && !banks.benevity)) throw new ServiceError(503, "QuickBooks is not connected");
  const { benevityMatchWindowDays } = await readIncomeSettings(client, orgId);
  const windows = rows.map((r) => matchWindow(r.payoutDate, r.source, benevityMatchWindowDays));
  const d = (await depositsIn(source, windows.map((w): [string, string] => [w.from, w.to]))).find((x) => x.id === qbTxnId);
  if (!d) return false;
  return rows.some((row, i) =>
    d.txnDate >= windows[i].from && d.txnDate <= windows[i].to &&
    ((d.appKey === rowKey(row)) || (d.depositToAccount === banks[isBenevity(row) ? DEPOSIT_SOURCE.BENEVITY : DEPOSIT_SOURCE.SHOPIFY] && d.totalCents === row.payoutNetCents)));
}

export const reconciliationService = {
  run(orgId: string, now?: Date) {
    return runReconcile(orgId, now);
  },

  list(orgId: string, status?: ReconStatus) {
    return db.payoutReconciliation.findMany({
      where: { orgId, status },
      orderBy: [{ payoutDate: "desc" }, { id: "desc" }],
    });
  },

  count(orgId: string, status?: ReconStatus) {
    return db.payoutReconciliation.count({ where: { orgId, status } });
  },

  /** Finance's queue: every OPEN payout, and any other payout the app left a note on. */
  listQueue(orgId: string) {
    return db.payoutReconciliation.findMany({
      where: { orgId, OR: [{ status: RECON_STATUS.OPEN }, { qbNote: { not: null } }] },
      orderBy: [{ payoutDate: "desc" }, { id: "desc" }],
    });
  },

  countQueue(orgId: string) {
    return db.payoutReconciliation.count({ where: { orgId, OR: [{ status: RECON_STATUS.OPEN }, { qbNote: { not: null } }] } });
  },

  /** Finance answers the app's note on a payout without changing anything else; the reason is audited. */
  async clearNote(orgId: string, id: number, reason: string, actor: Actor) {
    const why = reason.trim();
    if (!why) throw new ServiceError(400, "A reason is required");
    await openRow(orgId, id);
    return db.$transaction(async (tx) => {
      await lockReconciliation(tx, orgId, true);
      const current = await tx.payoutReconciliation.findUniqueOrThrow({ where: { id } });
      if (!current.qbNote) throw new ServiceError(409, "The payout has no note to clear");
      const saved = await tx.payoutReconciliation.update({ where: { id }, data: { qbNote: null } });
      await audit(tx, orgId, "reconciliation.note_cleared", current, saved, { ...actor, reason: why });
      return saved;
    });
  },

  async candidates(orgId: string, id: number) {
    const row = await openRow(orgId, id);
    return unclaimed(db, orgId, await windowDeposits(row));
  },

  /** A deposit whose amount differs from the payout's net needs finance's reason. */
  async matchToDeposit(orgId: string, id: number, depositId: string, actor: Actor, reason?: string) {
    const why = reason?.trim() || null;
    const linked = await ownEntryFirst(orgId, id, actor);
    if (linked) return linked;
    const row = await openRow(orgId, id);
    const inWindow = await windowDeposits(row);

    try {
      return await db.$transaction(async (tx) => {
        await lockReconciliation(tx, orgId, true);
        const deposit = (await unclaimed(tx, orgId, inWindow)).find((d) => d.id === depositId);
        if (!deposit) throw new ServiceError(422, "Deposit is not an unclaimed candidate for this payout");
        const current = await tx.payoutReconciliation.findUnique({ where: { id } });
        if (current?.status !== RECON_STATUS.OPEN || isClaimed(current)) throw new ServiceError(409, "Already resolved");
        if (deposit.totalCents !== current.payoutNetCents && !why) {
          throw new ServiceError(400, "A reason is required when the deposit amount differs from the payout");
        }
        const saved = await tx.payoutReconciliation.update({
          where: { id },
          data: {
            status: RECON_STATUS.RESOLVED,
            kind: null,
            resolution: RECON_RESOLUTION.MANUAL,
            origin: deposit.appKey === rowKey(current) ? RECON_ORIGIN.CREATED : RECON_ORIGIN.MATCHED,
            reason: why,
            qbNote: null,
            postClaimedAt: null,
            depositId: deposit.id,
            depositTxnDate: deposit.txnDate,
            depositTotalCents: deposit.totalCents,
            resolvedByUserId: actor.userId,
            resolvedAt: new Date(),
          },
        });
        await audit(tx, orgId, "reconciliation.matched_manually", current, saved, { ...actor, reason: why });
        return saved;
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) throw new ServiceError(409, "Deposit already backs another payout");
      throw err;
    }
  },

  async dismiss(orgId: string, id: number, reason: string, actor: Actor) {
    const why = reason.trim();
    if (!why) throw new ServiceError(400, "A reason is required");
    const linked = await ownEntryFirst(orgId, id, actor);
    if (linked) return linked;

    return db.$transaction(async (tx) => {
      await lockReconciliation(tx, orgId, true);
      const current = await tx.payoutReconciliation.findUnique({ where: { id } });
      if (current?.status !== RECON_STATUS.OPEN || isClaimed(current)) throw new ServiceError(409, "Already resolved");
      const saved = await tx.payoutReconciliation.update({
        where: { id },
        data: {
          status: RECON_STATUS.RESOLVED,
          kind: null,
          resolution: RECON_RESOLUTION.DISMISSED,
          reason: why,
          qbNote: null,
          postClaimedAt: null,
          resolvedByUserId: actor.userId,
          resolvedAt: new Date(),
        },
      });
      await audit(tx, orgId, "reconciliation.dismissed", current, saved, { ...actor, reason: why });
      return saved;
    });
  },

  listExclusions(orgId: string) {
    return db.incomeQbMatchExclusion.findMany({ where: { orgId }, orderBy: { excludedAt: "desc" } });
  },

  /**
   * Permanently remove a QuickBooks deposit from matching (D5); there is no undo. A held
   * deposit, or one a payout the create path may still book would match, can't be excluded.
   */
  async excludeDeposit(orgId: string, qbTxnId: string, reason: string, actor: Actor) {
    const why = reason.trim();
    if (!why) throw new ServiceError(400, "A reason is required");

    try {
      return await db.$transaction(async (tx) => {
        await lockReconciliation(tx, orgId, true);
        const holder = await tx.payoutReconciliation.findUnique({
          where: { orgId_depositId: { orgId, depositId: qbTxnId } },
        });
        if (holder) throw new ServiceError(409, "Deposit backs a payout; reopen that payout first");
        if (await fitsPostablePayout(tx, orgId, qbTxnId)) {
          throw new ServiceError(409, "Deposit fits a payout still awaiting its deposit");
        }
        const saved = await tx.incomeQbMatchExclusion.create({
          data: { orgId, qbTxnId, reason: why, excludedByUserId: actor.userId },
        });
        await recordAudit(tx, {
          orgId,
          actorUserId: actor.userId,
          actorUsername: actor.username,
          action: "deposit.excluded",
          entityType: "qb_match_exclusion",
          entityId: saved.id,
          after: saved,
          reason: why,
          correlationId: actor.correlationId,
        });
        return saved;
      }, { timeout: 60_000 });
    } catch (err) {
      if (isUniqueConstraintError(err)) throw new ServiceError(409, "Deposit is already excluded");
      throw err;
    }
  },

  /**
   * Finance's go-ahead for a POST_FAILED or OVER_CAP payout: match before create, outside the
   * per-run caps. The drain never touches these rows.
   */
  async retry(orgId: string, id: number, actor: Actor) {
    const row = await openRow(orgId, id);
    if (row.status !== RECON_STATUS.OPEN || (row.kind !== RECON_KIND.POST_FAILED && row.kind !== RECON_KIND.OVER_CAP)) {
      throw new ServiceError(409, "Only a failed or over-cap deposit create can be retried");
    }
    return goAhead(orgId, id, actor, false);
  },

  /**
   * Finance's "book it" for a NO_DEPOSIT payout: the post path with the closed-books gate read
   * now, outside the per-run caps. It still matches first and never creates in closed books.
   */
  async book(orgId: string, id: number, actor: Actor) {
    const row = await openRow(orgId, id);
    if (row.status !== RECON_STATUS.OPEN || row.kind !== RECON_KIND.NO_DEPOSIT) {
      throw new ServiceError(409, "Only a payout with no matching deposit can be booked");
    }
    return goAhead(orgId, id, actor, true);
  },

  resolve(orgId: string, id: number, req: ResolveAction, actor: Actor) {
    switch (req.action) {
      case "match":
        return reconciliationService.matchToDeposit(orgId, id, req.depositId, actor, req.reason);
      case "dismiss":
        return reconciliationService.dismiss(orgId, id, req.reason, actor);
      case "retry":
        return reconciliationService.retry(orgId, id, actor);
      case "book":
        return reconciliationService.book(orgId, id, actor);
      case "clear_note":
        return reconciliationService.clearNote(orgId, id, req.reason, actor);
    }
  },
};
