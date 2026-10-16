import { describeDb as gate } from "@inventory/pg-test-harness";

export const describeDb = gate("BULK_DONATION_DATABASE_URL");
