/**
 * Mount an expense route factory under checkin's handler() (#1272 §3). handler() renders an
 * error's status only when it is `instanceof` its own ApiResponseError, so the library's HTTP
 * error is translated here, in the route's module graph.
 */
import { ExpenseHttpError } from "@inventory/expense";
import type { ExpenseRouteHandler } from "@inventory/expense";
import { ApiResponseError } from "@/security/handler";

export function expenseRoute(factory: ExpenseRouteHandler): ExpenseRouteHandler {
  return async (ctx) => {
    try {
      return await factory(ctx);
    } catch (err) {
      if (err instanceof ExpenseHttpError) throw new ApiResponseError(err.status, err.message);
      throw err;
    }
  };
}
