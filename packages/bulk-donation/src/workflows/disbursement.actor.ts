import { createActor } from 'xstate';
import { db as defaultDb, isUniqueConstraintError, type DbOrTx } from '../db';
import { disbursementMachine } from './disbursement.machine';
import { assertEventAccepted, isLegalTransition, isConsumedTriggerReplay } from './disbursement.invariants';
import { runAccountDetermination, isAllOwnersReady, type AccountDeterminationResult } from '../lib/disbursement-processor';
import { recordEvent } from '../repositories/audit';
import type { DisbursementEvent } from './disbursement.events';

/** Who/why context recorded on every workflow event. System actions pass nothing. */
export interface AuditContext {
  actorUserId?: number | null;
  actorUsername?: string | null;
  correlationId?: string | null;
}

/**
 * Run one workflow cycle for a disbursement INSIDE an existing transaction:
 * load snapshot, send the event, run account determination if it enters
 * processing, persist the resulting state, and append audit rows — all
 * atomically with whatever business mutation the caller already did in `tx`.
 *
 * Idempotent: no-op once a disbursement_events row exists (completion proof).
 */
export async function runDisbursementCycleTx(
  tx: DbOrTx,
  orgId: string,
  disbursementId: string,
  event: DisbursementEvent,
  audit: AuditContext = {},
): Promise<void> {
  const done = await tx.disbursementEvent.findFirst({
    where: { orgId, disbursementId },
    select: { id: true },
  });
  if (done) return;

  const row = await tx.disbursementSnapshot.findFirst({
    where: { orgId, disbursementId },
  });

  const oldVersion = row?.version ?? -1;
  const previousState = row?.state ?? 'awaiting_ownership';

  const actor = row
    ? createActor(disbursementMachine, {
        snapshot: disbursementMachine.resolveState({
          value: row.state,
          context: JSON.parse(row.context) as Record<string, never>,
        }),
      })
    : createActor(disbursementMachine);

  // The machine is the authority on whether this event may be applied here.
  // When the current state has no handler for the event there are two cases:
  //   • a duplicate/redelivered trigger for a disbursement that already advanced
  //     past where it applied — a benign replay, absorbed as an idempotent no-op
  //     so at-least-once delivery and retries stay safe; or
  //   • a genuinely illegal/out-of-order event (e.g. HOLD_RESUBMITTED before the
  //     disbursement was ever held) — surfaced as an error instead of being
  //     silently dropped, so it can never quietly diverge the workflow.
  if (!isLegalTransition(previousState, event.type)) {
    if (isConsumedTriggerReplay(previousState, event.type)) return;
    assertEventAccepted(previousState, event.type); // throws WorkflowTransitionError
  }

  actor.start();
  actor.send(event);

  let determinationResult: AccountDeterminationResult | null = null;
  if (String(actor.getSnapshot().value) === 'processing') {
    determinationResult = await runAccountDetermination(tx, orgId, disbursementId);
    // The synthetic processing → completed/on_hold transition is governed by the
    // machine too: the determination result must be an event processing accepts.
    assertEventAccepted('processing', determinationResult.type);
    actor.send({ type: determinationResult.type });
  }

  const finalState = String(actor.getSnapshot().value);
  actor.stop();

  // Reaching here with no change means a guard legitimately held the machine in
  // place (e.g. OWNER_ASSIGNED before all owners are ready) — a real no-op, not a
  // rejected event, since the event was accepted above. Nothing to persist.
  if (finalState === previousState && determinationResult === null) return;

  await persistStateTx(tx, orgId, disbursementId, previousState, finalState, determinationResult, oldVersion, event, audit);
}

async function persistStateTx(
  tx: DbOrTx,
  orgId: string,
  disbursementId: string,
  previousState: string,
  finalState: string,
  determinationResult: AccountDeterminationResult | null,
  oldVersion: number,
  triggeringEvent: DisbursementEvent,
  audit: AuditContext,
): Promise<void> {
  const now = new Date();
  const context = JSON.stringify({ orgId, disbursementId });

  const auditBase = {
    orgId,
    disbursementId,
    entityType: 'disbursement' as const,
    entityId: disbursementId,
    actorUserId: audit.actorUserId ?? null,
    actorUsername: audit.actorUsername ?? null,
    correlationId: audit.correlationId ?? null,
  };

  if (finalState === 'completed') {
    if (previousState === 'on_hold') {
      await resolvePendingHolds(tx, orgId, disbursementId, now, auditBase);
    }
    const payload = (determinationResult as { type: 'PROCESS_SUCCEEDED'; payload: object }).payload;
    let inserted = true;
    try {
      await tx.disbursementEvent.create({ data: { orgId, disbursementId, payload: JSON.stringify(payload) } });
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      inserted = false;
    }
    if (oldVersion >= 0) {
      await tx.disbursementSnapshot.delete({ where: { orgId_disbursementId: { orgId, disbursementId } } });
    }
    if (inserted) {
      await recordEvent(tx, { ...auditBase, eventType: 'STATE_TRANSITION', payload: { from: previousState, to: 'completed', triggeredBy: triggeringEvent.type } });
      await recordEvent(tx, { ...auditBase, eventType: 'DISBURSEMENT_COMPLETED', payload });
    }
    return;
  }

  if (finalState === 'on_hold') {
    if (previousState === 'on_hold') {
      await resolvePendingHolds(tx, orgId, disbursementId, now, auditBase);
    }
    const conflicts = (determinationResult as { type: 'ACCOUNT_UNRESOLVED'; conflicts: Array<{ txId: number; reason: 'NO_MATCH' | 'MULTIPLE_MATCHES'; matchedRows: unknown[] }> }).conflicts;
    for (const conflict of conflicts) {
      await tx.disbursementHold.create({
        data: {
          orgId,
          disbursementId,
          transactionId: conflict.txId,
          reason: conflict.reason,
          matchedRows: JSON.stringify(conflict.matchedRows),
          status: 'PENDING',
        },
      });
      await recordEvent(tx, { ...auditBase, entityType: 'transaction', entityId: conflict.txId, eventType: 'HOLD_CREATED', payload: { reason: conflict.reason } });
    }

    const newVersion = oldVersion + 1;
    if (oldVersion === -1) {
      await tx.disbursementSnapshot.create({
        data: { orgId, disbursementId, state: 'on_hold', context, version: 0 },
      });
    } else {
      const result = await tx.disbursementSnapshot.updateMany({
        where: { orgId, disbursementId, version: oldVersion },
        data: { state: 'on_hold', context, version: newVersion },
      });
      if (result.count === 0) {
        throw new Error(`Disbursement ${disbursementId}: snapshot version conflict (expected ${oldVersion})`);
      }
    }
    await recordEvent(tx, { ...auditBase, eventType: 'STATE_TRANSITION', payload: { from: previousState, to: 'on_hold', triggeredBy: triggeringEvent.type } });
  }
}

async function resolvePendingHolds(
  tx: DbOrTx,
  orgId: string,
  disbursementId: string,
  now: Date,
  auditBase: { orgId: string; disbursementId: string; actorUserId: number | null; actorUsername: string | null; correlationId: string | null },
): Promise<void> {
  const pendingHolds = await tx.disbursementHold.findMany({
    where: { orgId, disbursementId, status: 'PENDING' },
  });
  if (pendingHolds.length > 0) {
    await tx.disbursementHold.updateMany({
      where: { orgId, disbursementId, status: 'PENDING' },
      data: { status: 'RESOLVED', resolvedAt: now },
    });
  }
  for (const h of pendingHolds) {
    await recordEvent(tx, {
      orgId, disbursementId,
      entityType: 'transaction', entityId: h.transactionId,
      eventType: 'HOLD_RESOLVED',
      actorUserId: auditBase.actorUserId, actorUsername: auditBase.actorUsername, correlationId: auditBase.correlationId,
    });
  }
}

/**
 * Compute readiness (single authoritative site) and run an OWNER_ASSIGNED cycle
 * inside the caller's transaction. Use from routes after the owner mutation so
 * the mutation and the workflow advance commit atomically.
 */
export async function runOwnerAssignedCycleTx(tx: DbOrTx, orgId: string, disbursementId: string, audit: AuditContext = {}): Promise<void> {
  const allReady = await isAllOwnersReady(tx, orgId, disbursementId);
  await runDisbursementCycleTx(tx, orgId, disbursementId, { type: 'OWNER_ASSIGNED', allReady }, audit);
}

/** Max times sendDisbursementEvent re-runs its transaction on a concurrency conflict. */
const MAX_TX_RETRIES = 5;

/**
 * Is this error a transient write-conflict that a fresh transaction would absorb?
 *
 * On real Postgres, overlapping cycles on the same disbursement race three ways, all of
 * which a retry resolves once the winner has committed (the idempotency guards in
 * runDisbursementCycleTx then turn the loser's re-run into a clean no-op / version-checked
 * update):
 *   - P2002: two cycles both saw "no snapshot yet" and raced `disbursementSnapshot.create`
 *     on the (orgId, disbursementId) PK — one commits, the other hits a unique violation;
 *   - the optimistic version check (updateMany where version=oldVersion → count 0) throwing
 *     the explicit "snapshot version conflict" error;
 *   - a Serializable write-conflict / deadlock, which Prisma surfaces as P2034 (and which
 *     the raw driver may also report as Postgres 40001 / 40P01).
 *
 * Under SQLite this never fired because the better-sqlite3 adapter holds one connection and
 * serializes whole transactions; Postgres actually runs them concurrently, so the retry is
 * what now provides that safety.
 */
function isRetryableTxConflict(err: unknown): boolean {
  if (isUniqueConstraintError(err)) return true;
  const code = (err as { code?: string } | null)?.code;
  if (code === 'P2034' || code === '40001' || code === '40P01') return true;
  return err instanceof Error && /snapshot version conflict/.test(err.message);
}

/**
 * Standalone entry: opens its own transaction and runs one cycle. Used by the
 * resubmit route and by tests.
 *
 * Runs Serializable with a bounded retry loop so concurrent cycles on the same disbursement
 * converge to a single consistent outcome instead of surfacing a write-conflict error.
 */
export async function sendDisbursementEvent(
  orgId: string,
  disbursementId: string,
  event: DisbursementEvent,
  audit: AuditContext = {},
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await defaultDb.$transaction(
        async (tx) => {
          await runDisbursementCycleTx(tx, orgId, disbursementId, event, audit);
        },
        { isolationLevel: 'Serializable' },
      );
      return;
    } catch (err) {
      if (attempt < MAX_TX_RETRIES && isRetryableTxConflict(err)) continue;
      throw err;
    }
  }
}
