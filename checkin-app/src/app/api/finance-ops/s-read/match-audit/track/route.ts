import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import prisma from "@/lib/prisma";
import * as mirror from "@/lib/shopifyRead/client";
import { isPaid, raisePaymentException } from "@/lib/finance/reconcile";

/**
 * POST /api/finance-ops/s-read/match-audit/track — promote ONE match-audit gap
 * row (MatchAuditPanel's "Track" button) to a tracked PaymentException. Human-
 * per-row only: nothing here is auto-raised.
 *
 * Same board gate + mirror-503 shape as the sibling GET — the panel
 * that surfaces these rows is itself mirror-gated (its GET 503s when unwired),
 * so a track request only ever reaches here after a successful audit.
 *
 * The gap predicate is re-run server-side from the raw Prisma columns (status,
 * kind, shopifyOrderId, manualPaymentById, wasOrgMemberAtApproval, mirror presence)
 * — NEVER from a bucket enum value — so a stale panel (a row already
 * activated/manually-paid/refunded/scholarship-approved since the audit ran)
 * cannot mint an exception. This keeps the route independent of whatever
 * bucket set matchAudit.ts happens to have (see that file's P2 buckets):
 * the only gaps this route ever promotes are the ones that re-derive true
 * below, regardless of bucket name. The exception KIND is chosen from the
 * re-derived state, not the bucket: a recorded-but-absent order is
 * PAYMENT_UNVERIFIABLE (payment on record, unverifiable), a missing order is
 * ACTIVE_WITHOUT_PAYMENT (no payment on record), an unclaimed paid order is
 * UNMATCHED_ORDER.
 */

export type TrackBody =
    | { kind: "order"; shopifyOrderId: string }
    | { kind: "membership"; processId: number }
    | { kind: "enrollment"; programId: number; personId: number };

function parseTrackBody(raw: unknown): TrackBody | null {
    if (!raw || typeof raw !== "object") return null;
    const b = raw as Record<string, unknown>;
    if (b.kind === "order") {
        return typeof b.shopifyOrderId === "string" && b.shopifyOrderId
            ? { kind: "order", shopifyOrderId: b.shopifyOrderId }
            : null;
    }
    if (b.kind === "membership") {
        const processId = parseInt(b.processId as string, 10);
        return Number.isNaN(processId) ? null : { kind: "membership", processId };
    }
    if (b.kind === "enrollment") {
        const programId = parseInt(b.programId as string, 10);
        const personId = parseInt(b.personId as string, 10);
        return Number.isNaN(programId) || Number.isNaN(personId) ? null : { kind: "enrollment", programId, personId };
    }
    return null;
}

async function trackOrder(shopifyOrderId: string): Promise<NextResponse> {
    // Staleness guards — the since-resolved cases for a paid-unclaimed order are:
    // it got activated, or it got refunded/cancelled.
    const [order] = await mirror.ordersByLegacyIds([shopifyOrderId]);
    if (!order) return apiError("Order not found in the mirror", 409);
    if (!isPaid(order)) return apiError("Order is no longer paid — refunded or cancelled since the audit", 409);
    // Since-activated: a non-archived membership process or ANY enrollment now carries this order.
    // ponytail: skip the variant re-check here — the panel only surfaces variant-matched
    // orders and the caller is board-gated, so re-deriving the whole membership+program
    // variant set per click (a second sweep) buys only defense against a forged id, not
    // against the real "since-resolved" cases (activated / refunded), which the checks
    // here cover. Add the variant intersection if a non-board surface ever calls this.
    const claimedProc = await prisma.orgMembershipProcess.findFirst({
        where: { shopifyOrderId, status: { not: "ARCHIVED" } },
        select: { id: true },
    });
    const claimedEnroll = await prisma.programParticipant.findFirst({
        where: { shopifyOrderId },
        select: { programId: true },
    });
    if (claimedProc || claimedEnroll) return apiError("Order has since been claimed by an activation", 409);
    await raisePaymentException("UNMATCHED_ORDER", { shopifyOrderId });
    return NextResponse.json({ tracked: true });
}

async function trackMembership(processId: number): Promise<NextResponse> {
    const p = await prisma.orgMembershipProcess.findUnique({
        where: { id: processId },
        select: { status: true, kind: true, shopifyOrderId: true, manualPaymentById: true },
    });
    if (!p) return apiError("Membership process not found", 404);
    // Only the population the audit sweeps: ACTIVE/PENDING_BG_CLEARANCE, INITIAL/RENEWAL.
    const swept = (p.status === "ACTIVE" || p.status === "PENDING_BG_CLEARANCE") && (p.kind === "INITIAL" || p.kind === "RENEWAL");
    if (!swept) return apiError("Not an active membership activation", 409);
    // Two distinct gaps, two distinct kinds: an order recorded-but-absent from the
    // mirror is PAYMENT_UNVERIFIABLE (a payment IS on record, just unverifiable);
    // no order at all is ACTIVE_WITHOUT_PAYMENT (no payment on record).
    if (p.shopifyOrderId) {
        if ((await mirror.orderLegacyIdsPresent([p.shopifyOrderId])).has(p.shopifyOrderId)) {
            return apiError("Membership is no longer a gap (its order is now in the mirror)", 409);
        }
        await raisePaymentException("PAYMENT_UNVERIFIABLE", { processId });
        return NextResponse.json({ tracked: true });
    }
    if (p.manualPaymentById != null) return apiError("Membership is no longer a gap (payment recorded manually since the audit)", 409);
    // ponytail: for the null-order kinds the @@unique(kind, shopifyOrderId) index does
    // NOT dedup (NULLs are distinct — no NULLS NOT DISTINCT), so two *concurrent*
    // clicks on the same row could create two ACTIVE_WITHOUT_PAYMENT rows.
    // raisePaymentException's app-level findFirst guards the real case (sequential
    // human clicks). Ceiling: a partial unique index with NULLS NOT DISTINCT would
    // close the race — deferred, it needs a migration and P3 ships none.
    await raisePaymentException("ACTIVE_WITHOUT_PAYMENT", { processId });
    return NextResponse.json({ tracked: true });
}

async function trackEnrollment(programId: number, personId: number): Promise<NextResponse> {
    const e = await prisma.programParticipant.findUnique({
        where: { programId_personId: { programId, personId } }, // @@id([programId, personId]) — schema.prisma
        select: { status: true, shopifyOrderId: true, wasOrgMemberAtApproval: true },
    });
    if (!e) return apiError("Enrollment not found", 404);
    if (e.status !== "ACTIVE") return apiError("Not an active enrollment", 409); // audit sweeps status ACTIVE only
    // Same split as trackMembership: recorded-but-absent order → PAYMENT_UNVERIFIABLE
    // (payment on record, unverifiable); no order → ACTIVE_WITHOUT_PAYMENT.
    if (e.shopifyOrderId) {
        if ((await mirror.orderLegacyIdsPresent([e.shopifyOrderId])).has(e.shopifyOrderId)) {
            return apiError("Enrollment is no longer a gap (its order is now in the mirror)", 409);
        }
        await raisePaymentException("PAYMENT_UNVERIFIABLE", { programId, personId });
        return NextResponse.json({ tracked: true });
    }
    if (e.wasOrgMemberAtApproval != null) return apiError("Enrollment is no longer a gap (scholarship-approved since the audit)", 409);
    // ponytail: for the null-order kinds the @@unique(kind, shopifyOrderId) index does
    // NOT dedup (NULLs are distinct — no NULLS NOT DISTINCT), so two *concurrent*
    // clicks on the same row could create two ACTIVE_WITHOUT_PAYMENT rows.
    // raisePaymentException's app-level findFirst guards the real case (sequential
    // human clicks). Ceiling: a partial unique index with NULLS NOT DISTINCT would
    // close the race — deferred, it needs a migration and P3 ships none.
    await raisePaymentException("ACTIVE_WITHOUT_PAYMENT", { programId, personId });
    return NextResponse.json({ tracked: true });
}

export const POST = withAuth(
    { roles: ["isBoardMember"] },
    async (req: NextRequest, auth) => {
        if (auth.type !== "session") {
            return apiError("Unauthorized", 401);
        }
        if (!mirror.isConfigured()) {
            return apiError("The Shopify mirror is not wired in this environment", 503);
        }

        let raw: unknown;
        try {
            raw = await req.json();
        } catch {
            return apiError("Invalid JSON", 400);
        }
        const body = parseTrackBody(raw);
        if (!body) return apiError("Invalid track request body", 400);

        try {
            if (body.kind === "order") return await trackOrder(body.shopifyOrderId);
            if (body.kind === "membership") return await trackMembership(body.processId);
            return await trackEnrollment(body.programId, body.personId);
        } catch (error) {
            logger.error("Failed to track match-audit gap:", error);
            return apiError("Failed to track the gap", 500);
        }
    },
);
