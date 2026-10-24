import prisma from "@/lib/prisma";
import { markBgConsent } from "@/lib/membership/external";
import { notifyReviewers } from "@/lib/membership/review";
import { bgFreshThreshold } from "@/lib/membership/personBgCheck";
import { openPersonBg } from "@/lib/membership/personBgTriggers";

/**
 * Manual "record an external background check → submit for review" — the Phase 3
 * board-driven path. Mirrors the household BG flow: an external check exists and
 * the board asserts it; the system never sees the check itself.
 *
 * Opens a PERSON_BG obligation for `personId` if one isn't already open (reuses
 * openPersonBg's dedup + Person-row lock, so it can't double-open), then marks it
 * review-ready by setting bgConsentAt via markBgConsent — consent is IMPLICIT in a
 * self-initiated external check (there is NO in-app consent link/email). Once
 * bgConsentAt is set the obligation surfaces in the reviewer queue; two
 * distinct-household reviewers then attest to clear it.
 *
 * Idempotent: a second submit re-uses the open process, markBgConsent no-ops, and
 * reviewers are pinged only on the FIRST submit (the transition into the queue).
 */
export class PersonBgSubmitError extends Error {
    constructor(public readonly code: "no_obligation", message: string) {
        super(message);
        this.name = "PersonBgSubmitError";
    }
}

export async function submitPersonBgForReview(personId: number, actorId: number) {
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
    const months = settings?.bgRecheckMonths ?? 0;
    // Open one if the person genuinely needs a check and none is open (dedup-guarded
    // inside openPersonBg). When the policy is unset we can only submit against an
    // obligation a trigger already opened.
    if (months > 0) {
        const now = new Date();
        await openPersonBg(personId, now, bgFreshThreshold(now, months));
    }

    const process = await prisma.orgMembershipProcess.findFirst({
        where: { kind: "PERSON_BG", subjectPersonId: personId, status: "PENDING_BG_REVIEW" },
        orderBy: { id: "desc" },
        select: { id: true, bgConsentAt: true },
    });
    if (!process) {
        throw new PersonBgSubmitError("no_obligation", "No open background-check obligation for this person.");
    }

    const firstSubmit = !process.bgConsentAt;
    await markBgConsent(process.id, actorId, "PERSON_BG"); // sets bgConsentAt (+ audit row), idempotent
    if (firstSubmit) await notifyReviewers(); // ping only on the transition into the queue
    return process;
}
