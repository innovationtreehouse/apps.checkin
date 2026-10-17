// Mounts an income route factory through checkin's handler(). The endpoint
// string MUST match its src/security/registry/income.ts entry.
import { handler } from "@/security/handler";
import { incomeRoute } from "@/lib/income/route";
import { routes } from "@checkin/income";

export const GET = handler("GET /api/income/reconciliation/count", incomeRoute(routes.countReconciliation));
