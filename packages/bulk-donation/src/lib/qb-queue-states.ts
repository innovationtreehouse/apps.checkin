// The finance queue's states, kept free of runtime imports so the client screen can use them.
import type { QbMatchState } from "./qb-match";

/** States the drain hands to finance; the queue lists these, and any record carrying a note. BEFORE_LINE is held as UNBOOKED. */
export const QB_HELD_STATES: readonly QbMatchState[] = ["AMBIGUOUS", "UNBOOKED", "BEFORE_LINE", "POST_FAILED", "NEEDS_FINANCE", "DRIFT"];

/** Held states finance may hand back to the drain. UNBOOKED goes back only by "book it"; DRIFT is finance's to decide. */
export const QB_RETRYABLE_STATES: readonly QbMatchState[] = ["AMBIGUOUS", "POST_FAILED", "NEEDS_FINANCE"];

/** Held states finance may have the app book: not in QuickBooks, and not created on the drain's own. */
export const QB_BOOKABLE_STATES: readonly QbMatchState[] = ["UNBOOKED", "BEFORE_LINE"];
