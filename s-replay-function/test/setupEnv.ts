/** Worker-side: publish the harness container URL to SHOPIFY_READ_DATABASE_URL (unless already set). */
import { applyHarnessEnv } from "@checkin/pg-test-harness";

applyHarnessEnv({ envVar: "SHOPIFY_READ_DATABASE_URL", provideKey: "shopifyReadDbUrl" });
