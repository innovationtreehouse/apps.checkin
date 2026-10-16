import { describeDb as gate } from "@inventory/pg-test-harness";

export const describeDb = gate("RECEIPT_DATABASE_URL");
