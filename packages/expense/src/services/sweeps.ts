import { recoverStrandedQbExpenses } from "../lib/expense-qb-processor";
import { drainExpenseOutbox } from "../lib/expense-qb-poster";
import { checkQbDrift } from "../lib/expense-qb-drift";
import { sweepOutcomeNotices } from "../lib/outcome-notices";
import { catchUpCatalogEvents } from "./catalogEventConsumer";
import { replayReceivedPayloads } from "./intakeService";

/**
 * Expense's catch-up step for the host's daily reconcile cron: unfinished intake payloads and the
 * S5 cursor replay. Each part fails on its own. Returns counts only.
 */
export async function runExpenseCatchUp() {
  const intake = await replayReceivedPayloads().catch(() => ({ error: true }));
  const catalogEvents = await catchUpCatalogEvents().catch(() => ({ error: true }));
  return { intake, catalogEvents };
}

/**
 * Expense's QuickBooks step: stranded QB recovery, the outbox drain, the QB-3 drift check, then the
 * retry of outcome emails still owed. Each part fails on its own. Returns counts only.
 */
export async function runExpenseQbPosting() {
  const stranded = await recoverStrandedQbExpenses().catch(() => ({ error: true }));
  const qbPost = await drainExpenseOutbox().catch(() => ({ error: true }));
  const qbDrift = await checkQbDrift().catch(() => ({ error: true }));
  const outcomeNotices = await sweepOutcomeNotices().catch(() => ({ error: true }));
  return { stranded, qbPost, qbDrift, outcomeNotices };
}
