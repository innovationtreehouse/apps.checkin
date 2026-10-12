/**
 * Mount bulk-donation route factories under checkin's handler() / fileHandler()
 * (#1280 §5).
 *
 * Both render an error's status only when it is `instanceof` their own
 * ApiResponseError, so the library's HTTP error is translated here, in the
 * route's module graph.
 */
import { DonationHttpError } from "@inventory/bulk-donation";
import type { DonationFileRouteHandler, DonationRouteHandler } from "@inventory/bulk-donation";
import { ApiResponseError } from "@/security/handler";

function translate(err: unknown): unknown {
  return err instanceof DonationHttpError ? new ApiResponseError(err.status, err.message) : err;
}

export function donationRoute(factory: DonationRouteHandler): DonationRouteHandler {
  return async (ctx) => {
    try {
      return await factory(ctx);
    } catch (err) {
      throw translate(err);
    }
  };
}

export function donationFileRoute(factory: DonationFileRouteHandler): DonationFileRouteHandler {
  return async (ctx) => {
    try {
      return await factory(ctx);
    } catch (err) {
      throw translate(err);
    }
  };
}
