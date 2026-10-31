// Re-export stub: mounts an expense route factory under /api/expense/* through
// checkin's handler(). The endpoint string MUST match its src/security/registry/expense.ts entry.
import { handler } from "@/security/handler";
import { expenseRoute } from "@/lib/expense/route";
import { routes } from "@checkin/expense";

export const GET = handler("GET /api/expense/expenses/[id]/reimbursee/options", expenseRoute(routes.expenses.reimburseePeople));
