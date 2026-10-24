import { describeDb as gate } from "@checkin/pg-test-harness";

export const describeDb = gate("SHOPIFY_READ_DATABASE_URL");
