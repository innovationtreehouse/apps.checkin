// The finance queue's states, kept free of runtime imports so the client screen can use them.
import type { QbMatchState } from "./qb-match";

/** States the drain hands to finance; the queue lists these. */
export const QB_HELD_STATES: readonly QbMatchState[] = ["AMBIGUOUS", "BEFORE_LINE", "POST_FAILED", "NEEDS_FINANCE"];

/** Held states finance may hand back to the drain; any other held state is finance's to match. */
export const QB_RETRYABLE_STATES: readonly QbMatchState[] = ["AMBIGUOUS", "BEFORE_LINE", "POST_FAILED", "NEEDS_FINANCE"];
