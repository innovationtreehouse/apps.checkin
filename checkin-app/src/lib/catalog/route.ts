/**
 * Mount a global-catalog route factory under checkin's handler() (#1286 §3).
 *
 * handler() renders an error's status only when it is `instanceof` its own
 * ApiResponseError. The translation happens here, in the route's module graph,
 * because the instrumentation bundle holds a separate copy of that class.
 */
import { CatalogHttpError } from "@inventory/global-catalog";
import type { CatalogRouteHandler } from "@inventory/global-catalog";
import { ApiResponseError } from "@/security/handler";

export function catalogRoute(factory: CatalogRouteHandler): CatalogRouteHandler {
  return async (ctx) => {
    try {
      return await factory(ctx);
    } catch (err) {
      if (err instanceof CatalogHttpError) throw new ApiResponseError(err.status, err.message);
      throw err;
    }
  };
}
