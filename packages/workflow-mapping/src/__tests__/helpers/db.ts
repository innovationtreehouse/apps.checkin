import { describeDb as gate } from "@checkin/pg-test-harness";

export const describeDb = gate("WORKFLOW_MAPPING_DATABASE_URL");
