/** Worker-side: publish the harness container URL to WORKFLOW_MAPPING_DATABASE_URL (unless
 *  already set, so a developer pointing at their own Postgres always wins). Runs before any
 *  test module evaluates, so the lazy `db` client and the describeDb gate see the URL. */
import { applyHarnessEnv } from "@inventory/pg-test-harness";

applyHarnessEnv({ envVar: "WORKFLOW_MAPPING_DATABASE_URL", provideKey: "workflowMappingDbUrl" });
