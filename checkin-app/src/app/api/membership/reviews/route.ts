import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { handler, unauthorized } from "@/security/handler";
import { eligibleReviewProcessIds, attestedUnclearedProcessIds, ownRejectedProcessIds, attest, subjectIds, ReviewError } from "@/lib/membership/review";
import { apiError } from "@/lib/api-response";
import { reviewErrorResponse } from "@/lib/domainErrorResponse";

export const dynamic = "force-dynamic";

const REVIEW_QUEUE_SELECT = {
    id: true,
    subjectPerson: { select: { id: true, name: true, householdId: true, household: { select: { name: true } } } },
    requestedForHousehold: {
        select: {
            name: true,
            // The applicant's "anything else we should know?" note — the signal a
            // volunteer-only household uses to ask the reviewer to mark them volunteer.
            intakeNotes: true,
            householdMembers: { where: { isHouseholdLead: true }, select: { id: true, name: true, email: true } },
        },
    },
    _count: { select: { attestations: true } },
} satisfies Prisma.OrgMembershipProcessSelect;

/**
 * GET /api/membership/reviews — check reviews this reviewer may decide, with
 * `?mine=1` the ones they already approved that have not cleared, or with
 * `?rejected=1` the blocked ones they rejected (which they may change to approve).
 *
 * Eligibility is computed in the service; the result is returned as model rows
 * so the security stripper governs field visibility (registry grants reviewers
 * pii + public only). The attestation _count is the approval count: a review in
 * the queue only ever holds approvals. Nothing about who decided is selected, so
 * reviewer B never learns that reviewer A signed off.
 *
 * A review with a person selects that person (name + household context). A review a
 * household asked for also selects that household: its name, its intake note, and
 * ONLY its leads' person rows, the people its first reviewer names from. Children
 * are never selected.
 */
export const GET = handler("GET /api/membership/reviews", async ({ req, auth }) => {
    if (auth.type !== "session") throw unauthorized();
    const params = new URL(req.url).searchParams;
    const ids = params.get("mine") === "1" ? await attestedUnclearedProcessIds(auth.user.id)
        : params.get("rejected") === "1" ? await ownRejectedProcessIds(auth.user.id)
        : await eligibleReviewProcessIds(auth.user.id);
    const queue = await prisma.orgMembershipProcess.findMany({
        where: { id: { in: ids } },
        orderBy: { stageEnteredAt: "asc" },
        select: REVIEW_QUEUE_SELECT,
    });
    return { OrgMembershipProcess: queue };
});

// POST /api/membership/reviews — record a decision on a check review
// { processId, result, isMarkedVolunteerFamily, subjectPersonIds }.
// Board members are implicit reviewers (see canReviewBackgroundChecks); attest()
// re-checks. The first decision on a review with no person names one lead of the
// requested household in subjectPersonIds, on a rejection as well as an approval.
// An APPROVE from the reviewer whose rejection blocked the review changes their
// answer: the review starts over with that approval as its first.
export const POST = withAuth({ roles: ["isBackgroundCheckReviewer", "isBoardMember"] }, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    let body: { processId?: number; result?: "APPROVE" | "REJECT"; isMarkedVolunteerFamily?: boolean; note?: string; subjectPersonIds?: number[] };
    try {
        body = await req.json();
    } catch {
        return apiError("Invalid JSON", 400);
    }
    if (!body.processId || (body.result !== "APPROVE" && body.result !== "REJECT")) {
        return apiError("processId and result (APPROVE|REJECT) are required", 400);
    }
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (body.result === "REJECT" && !note) {
        return apiError("A note explaining the denial is required", 400);
    }
    try {
        const outcome = await attest(auth.user.id, body.processId, {
            result: body.result,
            isMarkedVolunteerFamily: body.isMarkedVolunteerFamily,
            note: note || undefined,
            subjectPersonIds: subjectIds(body.subjectPersonIds),
        });
        return NextResponse.json({ outcome });
    } catch (error) {
        if (error instanceof ReviewError) {
            return reviewErrorResponse(error);
        }
        logger.error("Attestation error:", error);
        return apiError("Internal Server Error", 500);
    }
});
