// Mounts an income route factory through checkin's handler(). The endpoint
// string MUST match its src/security/registry/income.ts entry.
import { handler, unauthorized, type HandlerContext } from "@/security/handler";
import { componentRoute } from "@/lib/components/route";
import { routes } from "@checkin/income";

export const GET = handler("GET /api/income/settings", componentRoute(routes.getSettings));
export const PATCH = handler(
  "PATCH /api/income/settings",
  componentRoute(async (ctx: HandlerContext) => {
    if (ctx.auth.type !== "session") throw unauthorized();
    const { user } = ctx.auth;
    return routes.updateSettings({ isFinance: user.isFinance === true, isBoard: user.isBoardMember === true })(ctx);
  }),
);
