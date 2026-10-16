import { describeDb as gate } from "@inventory/pg-test-harness";

export const describeDb = gate("EXPENSE_DATABASE_URL");
