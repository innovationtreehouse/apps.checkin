import type { PrismaClient } from "../generated/prisma/client";
import { resolveNextState } from "../workflows/expense.invariants";
import type { ExpenseEvent } from "../workflows/expense.events";
import type { ExpenseMachineContext } from "../workflows/expense.guards";
import { NEUTRAL_CONTEXT } from "../workflows/expense.guards";
import { ServiceError } from "@checkin/component-kit";
import { oweOutcomeNotice, owesOutcome, sendOutcomeNotices } from "./outcome-notices";

type Db = PrismaClient;

// Structural type satisfied by both PrismaClient and Prisma interactive-transaction
// clients (which omit $connect/$disconnect/$on/$transaction/$use/$extends).
type DbLike = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

/** The expense left `currentState` before this transition committed: a concurrent call won. */
export class StaleStateError extends ServiceError {
  constructor(expenseId: string, expected: string) {
    super(409, `Expense ${expenseId} is no longer ${expected}; reload and retry`);
    this.name = "StaleStateError";
  }
}

/** Swallows a lost transition race (the winner carries the flow on); null when lost. */
export function unlessRaceLost(err: unknown): null {
  if (err instanceof StaleStateError) return null;
  throw err;
}

export interface Actor {
  userId: number;
  username?: string | null;
}

export interface TransitionOptions {
  expenseId: string;
  currentState: string;
  event: ExpenseEvent;
  context?: ExpenseMachineContext;
  actor: Actor;
  action: string;
  auditLineItemId?: number | null;
  auditNotes?: string | null;
}

export interface AdvanceWorkflowOptions extends TransitionOptions {
  db: Db;
}

/**
 * Validates the transition against the XState machine and applies it using the
 * provided interactive-transaction client.  Callers must wrap this in a
 * db.$transaction() callback to ensure atomicity with any surrounding writes. Entering a final state
 * that owes an outcome email records it in the same transaction; the caller sends it after commit.
 */
export async function advanceWorkflowInTx(
  tx: DbLike,
  opts: TransitionOptions,
): Promise<string> {
  const {
    expenseId,
    currentState,
    event,
    context = NEUTRAL_CONTEXT,
    actor,
    action,
    auditLineItemId = null,
    auditNotes = null,
  } = opts;

  const nextState = resolveNextState(currentState, event, context);

  const moved = await tx.expense.updateMany({ where: { id: expenseId, state: currentState }, data: { state: nextState } });
  if (moved.count === 0) throw new StaleStateError(expenseId, currentState);
  await tx.expenseAuditLog.create({
    data: {
      expenseId,
      userId: actor.userId,
      username: actor.username ?? null,
      changedAt: new Date(),
      action,
      fieldChanged: "state",
      valueBefore: currentState,
      valueAfter: nextState,
      lineItemId: auditLineItemId ?? null,
      notes: auditNotes,
    },
  });
  await oweOutcomeNotice(tx, expenseId, nextState);

  return nextState;
}

/**
 * Validates and applies a workflow state transition in its own transaction.
 * Use advanceWorkflowInTx when the transition must be atomic with other writes.
 */
export async function advanceWorkflow(opts: AdvanceWorkflowOptions): Promise<string> {
  const { db, ...rest } = opts;
  let nextState!: string;
  await db.$transaction(async (tx) => {
    nextState = await advanceWorkflowInTx(tx, rest);
  });
  if (owesOutcome(nextState)) await sendOutcomeNotices([rest.expenseId]);
  return nextState;
}
