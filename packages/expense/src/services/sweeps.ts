import { recoverStrandedQbExpenses } from "../lib/expense-qb-processor";
import { catchUpCatalogEvents } from "./catalogEventConsumer";
import { replayReceivedPayloads } from "./intakeService";

/**
 * Expense's catch-up step for the host's daily reconcile cron: unfinished intake payloads, stranded
 * QB recovery and the S5 cursor replay. Each part fails on its own. Returns counts only.
 */
export async function runExpenseCatchUp() {
  const intake = await replayReceivedPayloads().catch(() => ({ error: true }));
  const [stranded, catalogEvents] = await Promise.allSettled([recoverStrandedQbExpenses(), catchUpCatalogEvents()]);
  return {
    intake,
    stranded: stranded.status === "fulfilled" ? stranded.value : { error: true },
    catalogEvents: catalogEvents.status === "fulfilled" ? catalogEvents.value : { error: true },
  };
}
