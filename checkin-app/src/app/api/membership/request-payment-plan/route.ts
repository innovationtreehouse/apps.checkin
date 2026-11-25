import { NextResponse } from "next/server";
import { leadMembersWhere } from "@/lib/household/leads";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { apiError } from "@/lib/api-response";
import { resolveScholarshipRecipients, notifyReviewTeam, sendScholarshipAck } from "@/lib/scholarshipEmails";
import { config } from "@/lib/config";
import { fromWhere } from "@/lib/membership/lifecycle";
import { liveMembershipYear } from "@/lib/membership/renewal";
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
            include: { orgMembership: { include: { household: { include: { householdMembers: { where: leadMembersWhere(), select: { id: true } } } } } } },
        });

        if (!process || !process.orgMembership?.household) {
            // orgMembership is null only for a PERSON_BG process, which has no membership fee to
            // plan, and household is null for an archived one — treat both as not-found.
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

        const base = config.baseUrl();
        const householdId = process.orgMembership.householdId;
        const notifyReview = () => notifyReviewTeam(
            "scholarship.membershipReview",
            { householdId: String(householdId), requestKind: scholarshipRequestKindLabel(kind), actionLink: `${base}/finance-ops/membership-payment-plan` },
            "Scholarship review-team notify failed (membership request):",
        );

        // Responses carry only success, never the process row (internal-tier
        // zoho/shopify ids and stage timestamps).
        if (process.isPaymentPlanRequested) {
            // A repeat with a new kind corrects the kind and tells the review team; anything else changes nothing.
            if (!kind || kind === process.scholarshipRequestKind) return NextResponse.json({ success: true });
            // Compare-and-set on the stored kind, so of two concurrent corrections only one notifies.
            const corrected = await prisma.orgMembershipProcess.updateMany({
                where: { id: processId, ...fromWhere('PENDING_PAYMENT'), isPaymentPlanRequested: true, scholarshipRequestKind: process.scholarshipRequestKind },
                data: { scholarshipRequestKind: kind as ScholarshipRequestKind },
            });
            if (corrected.count > 0) await notifyReview();
            return NextResponse.json({ success: true });
        }

        // The request is for the year live now; approval certifies that year.
        const settings = await prisma.boardSettings.findUnique({ where: { id: 1 }, select: { orgMembershipYearBoundary: true } });
        const paymentPlanYear = liveMembershipYear(settings?.orgMembershipYearBoundary, new Date());

        // Compare-and-set on the flag, so of two concurrent submits only one sends the emails.
        const flipped = await prisma.orgMembershipProcess.updateMany({
            where: { id: processId, ...fromWhere('PENDING_PAYMENT'), isPaymentPlanRequested: false },
            data: { isPaymentPlanRequested: true, paymentPlanYear, ...(kind ? { scholarshipRequestKind: kind as ScholarshipRequestKind } : {}) },
        });
        if (flipped.count === 0) return NextResponse.json({ success: true });

        await notifyReview();
        const recipients = await resolveScholarshipRecipients(householdId);
        await sendScholarshipAck(recipients, "scholarship.ackMembership", {});

        return NextResponse.json({ success: true });
    } catch (error) {
        logger.error("Membership payment plan request error:", error);
        return apiError("Failed to request payment plan", 500);
    }
});
