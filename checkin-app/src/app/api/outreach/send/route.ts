import { NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";
import { isPrismaError } from "@/lib/prismaUniqueViolation";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { computeRecipientSnapshot, type Audience } from "@/lib/outreach/recipients";
import { resolveBoundary, BoundaryNotSetError } from "@/lib/outreach/render";
import type { BusinessRole } from "@/types/auth";

export const dynamic = "force-dynamic";

const ROLES: BusinessRole[] = ["isBoardMember", "isSysadmin", "isOperations"];
const EMAIL_TYPES = new Set(["opening", "reminder"]);
const AUDIENCES = new Set(["a", "b", "c"]);

/** One in-flight BulkSend at a time — the create-then-drain guard (see recipients.ts /
 * process-batch for the rest of the flow). Thrown inside the transaction below and mapped
 * to 409 by the catch. */
class ConcurrentSendError extends Error {}

/**
 * POST /api/outreach/send — create a campaign send. Computes the recipient snapshot (§2.2)
 * and writes it as BulkSendItem rows (queued / skipped_unsubscribed) under a brand-new
 * BulkSend. Returns the pre-send counts so the page can show a confirm dialog before the
 * browser starts draining via /api/outreach/process-batch. No email is sent here.
 *
 * Concurrency: a Serializable transaction wraps the "is anything else in flight" check and
 * the insert, so two overlapping creates can't both pass the check — Postgres aborts the
 * loser with a serialization failure (P2034), mapped to 409 here, same as the read-then-act
 * 409 a plain check-then-insert would only approximate.
 */
export const POST = withAuth({ roles: ROLES }, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);

    let body: { emailType?: string; audience?: string };
    try {
        body = await req.json();
    } catch {
        return apiError("Invalid JSON", 400);
    }
    const emailType = body.emailType;
    const audience = body.audience;
    if (!emailType || !EMAIL_TYPES.has(emailType)) return apiError('emailType must be "opening" or "reminder"', 400);
    if (!audience || !AUDIENCES.has(audience)) return apiError('audience must be "a", "b", or "c"', 400);

    try {
        await resolveBoundary(new Date());
    } catch (e) {
        if (e instanceof BoundaryNotSetError) return apiError(e.message, 400);
        throw e;
    }

    const snapshot = await computeRecipientSnapshot(audience as Audience);
    let queued = 0;
    let skippedUnsubscribed = 0;
    for (const item of snapshot.items) {
        if (item.status === "queued") queued++;
        else skippedUnsubscribed++;
    }

    try {
        const bulkSend = await prisma.$transaction(
            async (tx) => {
                const inFlight = await tx.bulkSend.findFirst({ where: { completedAt: null }, select: { id: true } });
                if (inFlight) throw new ConcurrentSendError();
                return tx.bulkSend.create({
                    data: {
                        emailType,
                        audience,
                        senderId: auth.user.id,
                        // Nothing to drain — a send to zero recipients is trivially complete.
                        completedAt: snapshot.items.length === 0 ? new Date() : null,
                        items: { createMany: { data: snapshot.items } },
                    },
                });
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        return NextResponse.json(
            {
                bulkSend,
                counts: {
                    queued,
                    skippedUnsubscribed,
                    leadsWithoutEmail: snapshot.leadsWithoutEmail,
                    total: snapshot.items.length,
                },
            },
            { status: 201 },
        );
    } catch (e) {
        if (e instanceof ConcurrentSendError) return apiError("A send is already in progress.", 409);
        if (isPrismaError(e, "P2034")) {
            return apiError("A send is already in progress.", 409);
        }
        throw e;
    }
});
