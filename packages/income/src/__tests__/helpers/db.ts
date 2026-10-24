import { describeDb as gate } from "@checkin/pg-test-harness";

export const describeDb = gate("INCOME_DATABASE_URL");
