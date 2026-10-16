import { recoverStrandedQbExpenses } from "../lib/expense-qb-processor";
import { drainExpenseOutbox } from "../lib/expense-qb-poster";
import { checkQbDrift } from "../lib/expense-qb-drift";
import { catchUpCatalogEvents } from "./catalogEventConsumer";
import { replayReceivedPayloads } from "./intakeService";

/**
 * Expense's catch-up step for the host's daily reconcile cron: unfinished intake payloads, stranded
 * QB recovery, the S5 cursor replay, the QuickBooks outbox drain and the QB-3 drift check. Each part fails on its own.
 * Returns counts only.
 */
export async function runExpenseCatchUp() {
  const intake = await replayReceivedPayloads().catch(() => ({ error: true }));
  const [stranded, catalogEvents] = await Promise.allSettled([recoverStrandedQbExpenses(), catchUpCatalogEvents()]);
  const qbPost = await drainExpenseOutbox().catch(() => ({ error: true }));
  const qbDrift = await checkQbDrift().catch(() => ({ error: true }));
  return {
    intake,
    stranded: stranded.status === "fulfilled" ? stranded.value : { error: true },
    catalogEvents: catalogEvents.status === "fulfilled" ? catalogEvents.value : { error: true },
    qbPost,
    qbDrift,
  };
}
