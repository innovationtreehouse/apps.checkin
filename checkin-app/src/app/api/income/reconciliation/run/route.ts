// Mounts an income route factory through checkin's handler(). The endpoint
// string MUST match its src/security/registry/income.ts entry.
import { handler } from "@/security/handler";
import { componentRoute } from "@/lib/components/route";
import { routes } from "@checkin/income";

export const POST = handler("POST /api/income/reconciliation/run", componentRoute(routes.run));
