import { describeDb as gate } from "@inventory/pg-test-harness";

export const describeDb = gate("WORKFLOW_MAPPING_DATABASE_URL");
