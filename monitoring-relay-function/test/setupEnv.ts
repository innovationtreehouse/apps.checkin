/** Worker-side: publish the harness container URL to MONITORING_DATABASE_URL (unless already set). */
import { applyHarnessEnv } from "@checkin/pg-test-harness";

applyHarnessEnv({ envVar: "MONITORING_DATABASE_URL", provideKey: "monitoringDbUrl" });
