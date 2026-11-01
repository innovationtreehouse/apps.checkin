// Mounts the donation settings factories under checkin's handler(). The endpoint
// strings MUST match their src/security/registry/donation.ts entries.
import { handler, unauthorized, type HandlerContext } from "@/security/handler";
import { componentRoute } from "@/lib/components/route";
import { routes } from "@checkin/bulk-donation";

export const GET = handler("GET /api/donations/settings", componentRoute(routes.settings.get));
export const PATCH = handler(
  "PATCH /api/donations/settings",
  componentRoute(async (ctx: HandlerContext) => {
    if (ctx.auth.type !== "session") throw unauthorized();
    const { user } = ctx.auth;
    return routes.settings.update({ isFinance: user.isFinance === true, isBoard: user.isBoardMember === true })(ctx);
  }),
);
