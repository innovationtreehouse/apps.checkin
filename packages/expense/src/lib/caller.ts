import type { ExpensePrincipal } from "../contract";

/**
 * The caller's checkin person id. Throws on anything but an integer: Prisma drops a `where`
 * key whose value is undefined, so an id-less session would otherwise match every row.
 */
export function callerId(principal: Pick<ExpensePrincipal, "id"> | null | undefined): number {
  const id = principal?.id;
  if (typeof id !== "number" || !Number.isInteger(id)) throw new Error("caller has no person id");
  return id;
}

/** Audit attribution for a principal: id from callerId, plus a username snapshot. */
export function actorOf(principal: ExpensePrincipal): { userId: number; username: string | null } {
  return { userId: callerId(principal), username: principal.name };
}
