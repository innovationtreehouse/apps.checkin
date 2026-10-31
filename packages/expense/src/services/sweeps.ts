import { recoverStrandedQbExpenses } from "../lib/expense-qb-processor";
import { drainExpenseOutbox } from "../lib/expense-qb-poster";
import { checkQbDrift } from "../lib/expense-qb-drift";
import { logError } from "../lib/logger";
import { catchUpCatalogEvents } from "./catalogEventConsumer";
import { replayReceivedPayloads } from "./intakeService";

/** Logs why a sweep part failed; the cron's response carries only `{ error: true }`. */
const failed = (part: string) => (err: unknown) => {
  logError("expense_sweep_failed", { part }, err);
  return { error: true };
};

/**
 * Expense's catch-up step for the host's daily reconcile cron: unfinished intake payloads and the
 * S5 cursor replay. Each part fails on its own. Returns counts only.
 */
export async function runExpenseCatchUp() {
  const intake = await replayReceivedPayloads().catch(failed("intake"));
  const catalogEvents = await catchUpCatalogEvents().catch(failed("catalogEvents"));
  return { intake, catalogEvents };
}

/**
 * Expense's QuickBooks step: stranded QB recovery, the outbox drain, then the QB-3 drift check.
 * Each part fails on its own. Returns counts only, and the names of the parts that failed so the
 * host can record them on the cron run.
 */
export async function runExpenseQbPosting() {
  const stranded = await recoverStrandedQbExpenses().catch(failed("stranded"));
  const qbPost = await drainExpenseOutbox().catch(failed("qbPost"));
  const qbDrift = await checkQbDrift().catch(failed("qbDrift"));
  const parts = { stranded, qbPost, qbDrift };
  const failedParts = Object.entries(parts).flatMap(([part, outcome]) => (typeof outcome === "object" && "error" in outcome ? [part] : []));
  return { ...parts, failedParts };
}
