import { describeDb as gate } from "@checkin/pg-test-harness";

export const describeDb = gate("RECEIPT_DATABASE_URL");
