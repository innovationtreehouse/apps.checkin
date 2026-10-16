import { describeDb as gate } from "@inventory/pg-test-harness";

export const describeDb = gate("INCOME_DATABASE_URL");
