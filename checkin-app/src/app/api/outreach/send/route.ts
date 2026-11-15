import { NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";
import { isPrismaError } from "@/lib/prismaUniqueViolation";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { computeRecipientSnapshot } from "@/lib/outreach/recipients";
import { resolveBoundary, BoundaryNotSetError, type EmailType } from "@/lib/outreach/render";
import type { BusinessRole } from "@/types/auth";

export const dynamic = "force-dynamic";

const ROLES: BusinessRole[] = ["isBoardMember", "isSysadmin", "isOperations"];
const EMAIL_TYPES = new Set<string>(["opening", "reminder"] satisfies EmailType[]);

/** One in-flight BulkSend at a time — the create-then-drain guard (see recipients.ts /
 * process-batch for the rest of the flow). Thrown inside the transaction below and mapped
 * to 409 by the catch. */
class ConcurrentSendError extends Error {}

/**
 * POST /api/outreach/send — create a campaign send. Computes the recipient snapshot for the
 * email type's audience and writes it as queued BulkSendItem rows under a brand-new
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

    let body: { emailType?: string };
    try {
        body = await req.json();
    } catch {
        return apiError("Invalid JSON", 400);
    }
    const emailType = body.emailType;
    if (!emailType || !EMAIL_TYPES.has(emailType)) return apiError('emailType must be "opening" or "reminder"', 400);

    try {
        await resolveBoundary(new Date());
    } catch (e) {
        if (e instanceof BoundaryNotSetError) return apiError(e.message, 400);
        throw e;
    }

    const snapshot = await computeRecipientSnapshot(emailType as EmailType);

    try {
        const bulkSend = await prisma.$transaction(
            async (tx) => {
                const inFlight = await tx.bulkSend.findFirst({ where: { completedAt: null }, select: { id: true } });
                if (inFlight) throw new ConcurrentSendError();
                return tx.bulkSend.create({
                    data: {
                        emailType,
                        // The column predates fixed audiences; it now records the email type's audience.
                        audience: emailType,
                        senderId: auth.user.id,
                        // Nothing to drain — a send to zero recipients is trivially complete.
                        completedAt: snapshot.items.length === 0 ? new Date() : null,
                        items: { createMany: { data: snapshot.items.map((item) => ({ ...item, variant: "renew", status: "queued" })) } },
                    },
                });
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        return NextResponse.json(
            {
                bulkSend,
                counts: {
                    queued: snapshot.items.length,
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
