import type { Prisma } from "@/generated/prisma/client";

/**
 * The ONE definition of "authorized at the front desk right now": the adult has at
 * least one APPROVED review. Renewal leaves the prior approval APPROVED, so a
 * TrustedAdult routinely carries several — authorization is a property of the ADULT,
 * not of a single review. /operational, the deny notice, and the expiry sweep all read it.
 */
export const AUTHORIZED_REVIEW: Prisma.TrustedAdultReviewWhereInput = { status: "APPROVED" };

/** The one relevant fact about an APPROVED review for the expiry question. */
export type ApprovalExpiry = { trustedAdultId: number; reviewBy: Date | null };

/**
 * "Is this ADULT's authorization running out?" — answered once per adult, not per
 * review. Renewal never retires the prior approval, so an adult routinely carries
 * several APPROVED rows; the current authorization is the one with the LATEST
 * reviewBy. Collapse each adult's approvals to that row and keep only the ones
 * whose reviewBy falls in the warn window (now, warnThreshold]. An adult who
 * renewed early — a newer approval outliving the old row — drops out, because the
 * old row is no longer their current authorization.
 *
 * The warning email and todo-counts both read this so they cannot drift. Pass in
 * ALL of an adult's APPROVED reviews (unfiltered by the window), or the latest
 * cannot be identified; the caller may pre-scope to adults with a candidate.
 *
 * On a reviewBy tie the first row in `approvals` wins (kept), so pass them id-asc
 * for a deterministic winner — matters only to which row the sweep stamps.
 */
export function expiringApprovals<T extends ApprovalExpiry>(approvals: T[], now: Date, warnThreshold: Date): T[] {
    const currentByAdult = new Map<number, T>();
    for (const r of approvals) {
        if (!r.reviewBy) continue;
        const cur = currentByAdult.get(r.trustedAdultId);
        if (!cur || r.reviewBy > cur.reviewBy!) currentByAdult.set(r.trustedAdultId, r);
    }
    return [...currentByAdult.values()].filter((r) => r.reviewBy! > now && r.reviewBy! <= warnThreshold);
}
