import { describeDb as gate } from "@checkin/pg-test-harness";

export const describeDb = gate("BULK_DONATION_DATABASE_URL");
