import { recoverStrandedQbExpenses } from "../lib/expense-qb-processor";
import { catchUpCatalogEvents } from "./catalogEventConsumer";

/**
 * Expense's catch-up step for the host's daily reconcile cron: stranded QB recovery and the S5
 * cursor replay. Each half fails on its own. Returns counts only.
 */
export async function runExpenseCatchUp() {
  const [stranded, catalogEvents] = await Promise.allSettled([recoverStrandedQbExpenses(), catchUpCatalogEvents()]);
  return {
    stranded: stranded.status === "fulfilled" ? stranded.value : { error: true },
    catalogEvents: catalogEvents.status === "fulfilled" ? catalogEvents.value : { error: true },
  };
}
