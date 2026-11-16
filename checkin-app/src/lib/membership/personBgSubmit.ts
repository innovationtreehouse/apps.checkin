import { markCheckStarted } from "@/lib/membership/checkStarted";

/**
 * The Board's "record an external background check → submit for review": marks the
 * person's check started (markCheckStarted), which opens or reuses their check
 * review and puts it in the reviewers' queue. The system never sees the check.
 */
export function submitPersonBgForReview(personId: number, actorId: number) {
    return markCheckStarted(personId, actorId);
}
