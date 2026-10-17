import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import type { BusinessRole } from "@/types/auth";
import type { BulkSend } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

const ROLES: BusinessRole[] = ["isBoardMember", "isSysadmin", "isOperations"];
const STATUSES = ["queued", "sent", "failed", "skipped_unsubscribed", "skipped_denied", "sending"] as const;

async function countsFor(bulkSendId: number) {
    const groups = await prisma.bulkSendItem.groupBy({ by: ["status"], where: { bulkSendId }, _count: { _all: true } });
    const counts: Record<(typeof STATUSES)[number], number> = { queued: 0, sent: 0, failed: 0, skipped_unsubscribed: 0, skipped_denied: 0, sending: 0 };
    let total = 0;
    for (const g of groups) {
        if ((STATUSES as readonly string[]).includes(g.status)) counts[g.status as (typeof STATUSES)[number]] = g._count._all;
        total += g._count._all;
    }
    return { ...counts, total };
}

async function summarize(bulkSend: BulkSend) {
    return { ...bulkSend, counts: await countsFor(bulkSend.id) };
}

/** GET /api/outreach/status — the send panel's data: the current in-flight send (if any,
 * so the page can offer Resume) and the last completed send (the "last sent" log line). */
export const GET = withAuth({ roles: ROLES }, async () => {
    const inFlight = await prisma.bulkSend.findFirst({ where: { completedAt: null }, orderBy: { id: "desc" } });
    const lastCompleted = await prisma.bulkSend.findFirst({ where: { completedAt: { not: null } }, orderBy: { id: "desc" } });

    return NextResponse.json({
        inFlight: inFlight ? await summarize(inFlight) : null,
        lastCompleted: lastCompleted ? await summarize(lastCompleted) : null,
    });
});

/** POST /api/outreach/status — `{ action: "retry", bulkSendId }` re-queues that send's
 * `failed` items (status failed → queued) and reopens it for draining if it had completed. */
export const POST = withAuth({ roles: ROLES }, async (req) => {
    let body: { action?: string; bulkSendId?: number };
    try {
        body = await req.json();
    } catch {
        return apiError("Invalid JSON", 400);
    }
    if (body.action !== "retry" || !body.bulkSendId) return apiError('Body must be { action: "retry", bulkSendId }', 400);

    const bulkSend = await prisma.bulkSend.findUnique({ where: { id: body.bulkSendId } });
    if (!bulkSend) return apiError("Send not found", 404);

    // Reopening a completed send must not create a second in-flight row: two rows with
    // completedAt: null break the one-in-flight invariant (send/route.ts 409s every new
    // campaign, and process-batch's no-id fallback drains whichever is newest). Plain check —
    // the create path guards under Serializable, but this reopen's exposure is far narrower.
    if (bulkSend.completedAt) {
        const other = await prisma.bulkSend.findFirst({ where: { completedAt: null }, select: { id: true } });
        if (other) return apiError("A send is already in progress.", 409);
    }

    await prisma.bulkSendItem.updateMany({ where: { bulkSendId: bulkSend.id, status: "failed" }, data: { status: "queued", error: null } });
    const reopened = bulkSend.completedAt
        ? await prisma.bulkSend.update({ where: { id: bulkSend.id }, data: { completedAt: null } })
        : bulkSend;

    return NextResponse.json({ bulkSend: await summarize(reopened) });
});
