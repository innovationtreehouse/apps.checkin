// Re-export stub: mounts a workflow-mapping route factory under
// /api/workflow-mapping/* through checkin's handler(). The endpoint string MUST
// match its src/security/registry/workflow.ts entry.
import { handler } from "@/security/handler";
import { componentRoute } from "@/lib/components/route";
import { routes } from "@checkin/workflow-mapping";

export const POST = handler("POST /api/workflow-mapping/receipts/[id]/proceed", componentRoute(routes.proceed));
