// Mounts an income route factory through checkin's handler(). The endpoint
// string MUST match its src/security/registry/income.ts entry.
import { handler } from "@/security/handler";
import { incomeRoute } from "@/lib/income/route";
import { routes } from "@inventory/income";

export const GET = handler("GET /api/income/payouts/[gid]", incomeRoute(routes.getPayout));
