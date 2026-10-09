import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { apiError } from "@/lib/api-response";
import { resolveScholarshipRecipients, notifyReviewTeam, sendScholarshipAck, resolveAckCopy } from "@/lib/scholarshipEmails";
import { config } from "@/lib/config";
import { LIVE_PERSON } from "@/lib/person/filters";
import { ScholarshipRequestKind } from "@/generated/prisma/client";
import { scholarshipRequestKindLabel } from "@/lib/scholarshipRequestKind";

export const POST = withAuth({}, async (req, auth) => {
    if (auth.type !== 'session') return apiError("Unauthorized", 401);

    try {
        const body = await req.json();
        const processId = parseInt(body.processId, 10);
        if (Number.isNaN(processId)) {
            return apiError("processId is required", 400);
        }

        // An absent kind records as null rather than 400 — a stale tab mid-deploy
        // still gets its request in. A present-but-wrong one is a client bug.
        const kind = body.kind;
        if (kind !== undefined && kind !== null && !Object.values(ScholarshipRequestKind).includes(kind)) {
            return apiError("kind must be SCHOLARSHIP, PAYMENT_PLAN or UNSURE", 400);
        }

        const process = await prisma.orgMembershipProcess.findUnique({
            where: { id: processId },
            include: { orgMembership: { include: { household: { include: { householdMembers: { where: { isHouseholdLead: true, ...LIVE_PERSON }, select: { id: true } } } } } } },
        });

        if (!process || !process.orgMembership) {
            // orgMembership is null only for a PERSON_BG process, which has no dues to
            // plan — treat as not-found for this household-membership-only endpoint.
            return apiError("Membership application not found", 404);
        }

        // Authorization: only a sysadmin/board member or a lead of this process's
        // household may request a payment plan. Without this gate any authenticated
        // user could flip isPaymentPlanRequested on an arbitrary application (IDOR).
        const currentUserId = auth.user.id;
        const isSysAdminOrBoard = auth.user.isSysadmin || auth.user.isBoardMember;
        const isHouseholdLead = process.orgMembership.household.householdMembers.some((p) => p.id === currentUserId);

        if (!isSysAdminOrBoard && !isHouseholdLead) {
            return apiError("Forbidden: Not authorized to request a payment plan for this membership", 403);
        }

        if (process.status !== 'PENDING_PAYMENT') {
            return apiError("This application is not awaiting payment", 409);
        }

        if (process.isPaymentPlanRequested) {
            // Idempotent re-request: no transition, no emails, still success.
            // Return only res.ok — never echo the raw process row (internal-tier
            // zoho/shopify ids and stage timestamps) to the lead.
            return NextResponse.json({ success: true });
        }

        // select: the UI reads only res.ok — never echo the raw process row
        // (internal-tier zoho/shopify ids and stage timestamps) to the lead.
        await prisma.orgMembershipProcess.update({
            where: { id: processId },
            data: { isPaymentPlanRequested: true, ...(kind ? { scholarshipRequestKind: kind as ScholarshipRequestKind } : {}) },
            select: { id: true },
        });

        const base = config.baseUrl();
        const householdId = process.orgMembership.householdId;
        await notifyReviewTeam(
            `New membership scholarship / payment-plan request (household ${householdId})`,
            `<p>The Scholarship Review Team has a new membership scholarship / payment-plan request to review.</p>`
            + `<p>What they asked for: <strong>${scholarshipRequestKindLabel(kind)}</strong></p>`
            + `<p>Review it here: <a href="${base}/finance-ops/membership-payment-plan">${base}/finance-ops/membership-payment-plan</a></p>`,
            "Scholarship review-team notify failed (membership request):",
        );
        const recipients = await resolveScholarshipRecipients(householdId);
        const ackSettings = await prisma.boardSettings.findUnique({
            where: { id: 1 },
            select: { scholarshipAckSubject: true, scholarshipAckMembershipBody: true },
        });
        const ack = resolveAckCopy(ackSettings, "membership");
        await sendScholarshipAck(recipients, ack.subject, ack.body);

        return NextResponse.json({ success: true });
    } catch (error) {
        logger.error("Membership payment plan request error:", error);
        return apiError("Failed to request payment plan", 500);
    }
});
