// The finance queue's states, kept free of runtime imports so the client screen can use them.
import type { QbMatchState } from "./qb-match";

/** States the drain hands to finance; the queue lists these. */
export const QB_HELD_STATES: readonly QbMatchState[] = ["AMBIGUOUS", "BEFORE_LINE", "POST_FAILED", "NEEDS_FINANCE", "DRIFT"];

/** Held states finance may hand back to the drain. BEFORE_LINE goes straight back there; DRIFT is finance's to decide. */
export const QB_RETRYABLE_STATES: readonly QbMatchState[] = ["AMBIGUOUS", "POST_FAILED", "NEEDS_FINANCE"];
