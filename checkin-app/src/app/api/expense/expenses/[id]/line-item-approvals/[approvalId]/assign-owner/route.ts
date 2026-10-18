// Re-export stub (#1272): mounts an expense route factory under /api/expense/* through
// checkin's handler(). The endpoint string MUST match its src/security/registry/expense.ts entry.
import { handler } from "@/security/handler";
import { componentRoute } from "@/lib/components/route";
import { routes } from "@checkin/expense";

export const POST = handler("POST /api/expense/expenses/[id]/line-item-approvals/[approvalId]/assign-owner", componentRoute(routes.expenses.assign));
