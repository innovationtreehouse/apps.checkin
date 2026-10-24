import { callerId } from "@checkin/component-kit";
import type { ExpensePrincipal } from "../contract";

export { callerId };

/** Audit attribution for a principal: id from callerId, plus a username snapshot. */
export function actorOf(principal: ExpensePrincipal): { userId: number; username: string | null } {
  return { userId: callerId(principal), username: principal.name };
}
