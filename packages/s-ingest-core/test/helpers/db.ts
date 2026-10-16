import { describeDb as gate } from "@inventory/pg-test-harness";

export const describeDb = gate("SHOPIFY_READ_DATABASE_URL");
