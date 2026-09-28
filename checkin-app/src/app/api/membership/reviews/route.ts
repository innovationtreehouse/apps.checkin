import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { handler, unauthorized } from "@/security/handler";
import { eligibleReviewProcessIds, attestedUnclearedProcessIds, attest, subjectIds, ReviewError } from "@/lib/membership/review";
import { apiError } from "@/lib/api-response";
import { LIVE_PERSON } from "@/lib/person/filters";

export const dynamic = "force-dynamic";

const STATUS_FOR: Record<ReviewError["code"], number> = {
    not_reviewer: 403,
    not_found: 404,
    wrong_phase: 409,
    same_household_applicant: 403,
    same_household_reviewer: 403,
    already_attested: 409,
    invalid_subject: 400,
};

/**
 * GET /api/membership/reviews — applications this reviewer may attest, or with
 * `?mine=1` the ones they already approved that have not cleared.
 *
 * Eligibility is computed in the service; the result is returned as model rows
 * so the security stripper governs field visibility (registry grants reviewers
 * pii + public only — applicant parents' names/emails, nothing internal). The
 * attestation _count doubles as the approval count for queue rows.
 *
 * Attestations come back as bare `subjectPersonId`s so the card can show each lead's
 * own approval count — a reviewer needs to see that a household-mate is sitting at
 * 1 of 2 before they choose whom to name. Nothing else is selected: `reviewerId`
 * would tell reviewer B that reviewer A already signed off (anchoring), and `result`
 * is redundant because an awaiting process only ever holds APPROVEs.
 *
 * For a household review the query selects ONLY the household leads' (parents')
 * person rows — the reviewer never needs the children, so their PII never leaves
 * the DB. For a PERSON_BG it selects the SUBJECT person instead (name + household
 * context, subject may have no household), so the reviewer sees who they're
 * approving rather than a blank row. Both name/household fields are public-band, so
 * the stripper passes them for the reviewer grant; it stays defense-in-depth on top
 * of this narrowing, not the primary filter.
 */
export const GET = handler("GET /api/membership/reviews", async ({ req, auth }) => {
    if (auth.type !== "session") throw unauthorized();
    // ?mine=1: reviews this reviewer already approved that have not cleared.
    const mine = new URL(req.url).searchParams.get("mine") === "1";
    const ids = mine ? await attestedUnclearedProcessIds(auth.user.id) : await eligibleReviewProcessIds(auth.user.id);
    const queue = await prisma.orgMembershipProcess.findMany({
        where: { id: { in: ids } },
        orderBy: { stageEnteredAt: "asc" },
        select: {
            id: true,
            // The BG subject (set only on a PERSON_BG row): identity + household
            // context so the reviewer knows who the check is for. Household may be null.
            subjectPerson: {
                select: {
                    id: true,
                    name: true,
                    householdId: true,
                    household: { select: { name: true } },
                },
            },
            orgMembership: {
                select: {
                    household: {
                        select: {
                            name: true,
                            // The applicant's "anything else we should know?" note — the
                            // signal a volunteer-only household uses to ask the reviewer to
                            // mark them volunteer. Classified pii; reviewers hold that band.
                            intakeNotes: true,
                            // Live leads only: these are the selectable check subjects, and
                            // the service rejects a tombstone the card offered.
                            householdMembers: { where: { isHouseholdLead: true, ...LIVE_PERSON }, select: { id: true, name: true, email: true } },
                        },
                    },
                },
            },
            attestations: { select: { subjectPersonId: true } },
            _count: { select: { attestations: true } },
        },
    });
    return { OrgMembershipProcess: queue };
});

// POST /api/membership/reviews — submit an attestation
// { processId, result, isMarkedVolunteer, subjectPersonIds }.
// Board members are implicit reviewers (see canReviewBackgroundChecks); attest()
// re-checks, and validates the subjects against the household's live leads.
export const POST = withAuth({ roles: ["isBackgroundCheckReviewer", "isBoardMember"] }, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    let body: { processId?: number; result?: "APPROVE" | "REJECT"; isMarkedVolunteer?: boolean; note?: string; subjectPersonIds?: number[] };
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
            isMarkedVolunteer: body.isMarkedVolunteer,
            note: note || undefined,
            subjectPersonIds: subjectIds(body.subjectPersonIds),
        });
        return NextResponse.json({ outcome });
    } catch (error) {
        if (error instanceof ReviewError) {
            return NextResponse.json({ error: error.message, code: error.code }, { status: STATUS_FOR[error.code] });
        }
        logger.error("Attestation error:", error);
        return apiError("Internal Server Error", 500);
    }
});
