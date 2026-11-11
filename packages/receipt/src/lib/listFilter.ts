import { ServiceError } from "@checkin/component-kit";
import type { Prisma } from "../generated/prisma/client";

/** Narrows the org-wide receipt list: `state` to one machine state, `pushed` to whether it reached receiving. */
export interface ReceiptListFilter {
  state?: string;
  pushed?: boolean;
}

/** Reads `?state=` and `?pushed=0|1`; any other `pushed` value is a 400. */
export function parseListFilter(params: URLSearchParams): ReceiptListFilter {
  const state = params.get("state") || undefined;
  const pushed = params.get("pushed");
  if (pushed === null || pushed === "") return { state };
  if (pushed !== "0" && pushed !== "1") throw new ServiceError(400, `pushed must be 0 or 1, not "${pushed}"`);
  return { state, pushed: pushed === "1" };
}

/** The where clause for `filter` within the org. An unknown state matches no rows. */
export function listFilterWhere(orgId: string, filter: ReceiptListFilter): Prisma.ReceiptWhereInput {
  return {
    orgId,
    ...(filter.state ? { details: { state: filter.state } } : {}),
    ...(filter.pushed === undefined ? {} : { pushedAt: filter.pushed ? { not: null } : null }),
  };
}
