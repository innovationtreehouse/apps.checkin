/**
 * Mount a component library's route factory under checkin's handler() or fileHandler().
 *
 * Both render an error's status only when it is `instanceof` their own ApiResponseError,
 * so a library's expected failure is translated here, in the route's module graph. The kit
 * recognises it by brand, since the instrumentation chunk loads its own copy of the library.
 */
import { toHttpError } from "@checkin/component-kit";
import { ApiResponseError } from "@/security/handler";

/** The library failure as checkin's API error, or the error untouched for an opaque 500. */
export function toApiResponseError(err: unknown): unknown {
  const http = toHttpError(err);
  return http ? new ApiResponseError(http.status, http.message) : err;
}

export function componentRoute<C, R>(factory: (ctx: C) => Promise<R>): (ctx: C) => Promise<R> {
  return async (ctx) => {
    try {
      return await factory(ctx);
    } catch (err) {
      throw toApiResponseError(err);
    }
  };
}
