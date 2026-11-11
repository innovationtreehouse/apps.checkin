/**
 * Mount an expense route factory under checkin's handler(). The library receives the principal
 * from the auth handler() already resolved, so a request reads the session once.
 */
import type { ExpenseRouteHandler } from "@checkin/expense";
import { componentRoute } from "@/lib/components/route";
import { unauthorized, type HandlerContext } from "@/security/handler";

export function expenseRoute(factory: ExpenseRouteHandler) {
  return componentRoute(async ({ req, params, auth }: HandlerContext) => {
    if (auth.type !== "session") throw unauthorized();
    const { user } = auth;
    return factory({
      req,
      params,
      principal: { id: user.id, name: user.name ?? null, isFinance: user.isFinance === true, isBoard: user.isBoardMember === true },
    });
  });
}
