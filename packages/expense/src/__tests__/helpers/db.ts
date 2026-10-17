import { describeDb as gate } from "@checkin/pg-test-harness";

export const describeDb = gate("EXPENSE_DATABASE_URL");
