// Re-export stub (#1289): mounts a workflow-mapping route factory under
// /api/workflow-mapping/* through checkin's handler(). The endpoint string MUST
// match its src/security/registry/workflow.ts entry.
import { handler } from "@/security/handler";
import { workflowRoute } from "@/lib/workflowMapping/route";
import { routes } from "@inventory/workflow-mapping";

export const POST = handler("POST /api/workflow-mapping/receipts/[id]/lines/[lineStatusId]/associate", workflowRoute(routes.associate));
