/**
 * Mount a local-inventory route factory under checkin's handler() (#1287 §3).
 *
 * handler() renders an error's status only when it is `instanceof` its own
 * ApiResponseError, so the library's HTTP error is translated here, in the
 * route's module graph.
 */
import { InventoryHttpError } from "@inventory/local-inventory";
import type { InventoryRouteHandler } from "@inventory/local-inventory";
import { ApiResponseError } from "@/security/handler";

export function inventoryRoute(factory: InventoryRouteHandler): InventoryRouteHandler {
  return async (ctx) => {
    try {
      return await factory(ctx);
    } catch (err) {
      if (err instanceof InventoryHttpError) throw new ApiResponseError(err.status, err.message);
      throw err;
    }
  };
}
