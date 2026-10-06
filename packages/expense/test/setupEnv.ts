/** Worker-side: publish the harness container URL to EXPENSE_DATABASE_URL (unless already
 *  set, so a developer pointing at their own Postgres always wins). Runs before any test
 *  module evaluates, so the lazy `db` client and the describeDb gate see the URL. */
import { applyHarnessEnv } from "@inventory/pg-test-harness";

applyHarnessEnv({ envVar: "EXPENSE_DATABASE_URL", provideKey: "expenseDbUrl" });
