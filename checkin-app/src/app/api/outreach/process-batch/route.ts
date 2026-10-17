import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { sendEmail } from "@/lib/email";
import { renderOutreachEmail, resolveBoundary, loadTemplate, BoundaryNotSetError, type EmailType, type OutreachVariant } from "@/lib/outreach/render";
import type { BusinessRole } from "@/types/auth";

export const dynamic = "force-dynamic";

const ROLES: BusinessRole[] = ["isBoardMember", "isSysadmin", "isOperations"];
const BATCH_SIZE = 40; // within the spec's ~25-50/round

/**
 * POST /api/outreach/process-batch — claim and drain one batch of a BulkSend's `queued`
 * items. The browser calls this in a loop until `remaining` is 0 (see the send panel).
 *
 * No double-send: each candidate item is claimed with a guarded `updateMany where
 * id=<id> AND status='queued'` BEFORE it is sent — the claim must land before sendEmail,
 * not after, because the ledger can only prevent a double *write*, not a double *send*, if
 * the guard ran afterward. A losing claim (count 0, e.g. a retried/duplicate POST racing
 * another in-flight process-batch call for the same item) is simply skipped.
 *
 * ponytail: the claim writes a transient "sending" status — not one of the four the design
 * doc names (queued/sent/failed/skipped_unsubscribed/skipped_denied) — as the atomic marker, since Prisma's
 * updateMany can't return which rows it touched. A crash in the narrow window between claim
 * and finalize could strand a single item in "sending" (not resumable by count-of-queued or
 * retry-failed); add a stale-"sending" reaper if that's ever observed in practice.
 */
export const POST = withAuth({ roles: ROLES }, async (req) => {
    let body: { bulkSendId?: number } = {};
    try {
        body = await req.json();
    } catch {
        // empty body is fine — falls back to the current in-flight send below
    }

    const bulkSend = body.bulkSendId
        ? await prisma.bulkSend.findUnique({ where: { id: body.bulkSendId } })
        : await prisma.bulkSend.findFirst({ where: { completedAt: null }, orderBy: { id: "desc" } });
    if (!bulkSend || bulkSend.completedAt) return apiError("No in-flight send.", 404);

    let boundary;
    try {
        boundary = await resolveBoundary(new Date());
    } catch (e) {
        if (e instanceof BoundaryNotSetError) return apiError(e.message, 400);
        throw e;
    }
    const template = await loadTemplate(bulkSend.emailType as EmailType);

    const candidates = await prisma.bulkSendItem.findMany({
        where: { bulkSendId: bulkSend.id, status: "queued" },
        orderBy: { id: "asc" },
        take: BATCH_SIZE,
    });

    let processed = 0;
    for (const item of candidates) {
        const claim = await prisma.bulkSendItem.updateMany({ where: { id: item.id, status: "queued" }, data: { status: "sending" } });
        if (claim.count === 0) continue; // already claimed elsewhere — skip, don't send

        const person = await prisma.person.findUnique({
            where: { id: item.personId },
            select: { name: true, emailSuppressed: true, household: { select: { orgMembership: { select: { status: true } } } } },
        });
        // A household denied after the snapshot was frozen gets nothing either.
        if (person?.household?.orgMembership?.status === "DENIED") {
            await prisma.bulkSendItem.update({ where: { id: item.id }, data: { status: "skipped_denied" } });
            continue;
        }
        // Honor an unsubscribe that landed AFTER the snapshot was frozen: the drain resumes
        // arbitrarily later (survives deploys), so re-check suppression at send time. Join-only,
        // recorded (not dropped) as the same status the snapshot path uses — spec §2.4.
        if (item.variant === "join" && person?.emailSuppressed) {
            await prisma.bulkSendItem.update({ where: { id: item.id }, data: { status: "skipped_unsubscribed" } });
            continue;
        }
        const { subject, html } = renderOutreachEmail(template.subject, template.body, {
            name: person?.name ?? "",
            variant: item.variant as OutreachVariant,
            boundary,
            personId: item.variant === "join" ? item.personId : undefined,
        });

        const ok = await sendEmail(item.email, subject, html);
        await prisma.bulkSendItem.update({
            where: { id: item.id },
            data: ok ? { status: "sent", sentAt: new Date() } : { status: "failed", error: "sendEmail failed" },
        });
        processed++;
    }

    const remaining = await prisma.bulkSendItem.count({ where: { bulkSendId: bulkSend.id, status: "queued" } });
    if (remaining === 0) {
        await prisma.bulkSend.update({ where: { id: bulkSend.id }, data: { completedAt: new Date() } });
    }

    return NextResponse.json({ bulkSendId: bulkSend.id, processed, remaining });
});
