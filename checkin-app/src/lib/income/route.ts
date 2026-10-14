/**
 * Mount an income route factory under checkin's handler(). handler() renders an
 * error's status only when it is `instanceof` its own ApiResponseError, so the
 * library's HTTP error is translated here, in the route's module graph.
 */
import { IncomeHttpError, type IncomeRouteHandler } from "@inventory/income";
import { ApiResponseError } from "@/security/handler";

export function incomeRoute(factory: IncomeRouteHandler): IncomeRouteHandler {
  return async (ctx) => {
    try {
      return await factory(ctx);
    } catch (err) {
      if (err instanceof IncomeHttpError) throw new ApiResponseError(err.status, err.message);
      throw err;
    }
  };
}
