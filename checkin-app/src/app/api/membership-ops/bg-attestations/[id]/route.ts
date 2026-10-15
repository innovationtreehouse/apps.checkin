import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { logBackendError } from "@/lib/logger";

export const dynamic = "force-dynamic";

/** Thrown inside the transaction when the id no longer resolves — caught below and mapped to a 404. */
class NotFoundError extends Error {}

// Prisma known-request errors carry a string `code`. Duck-typed so we don't
// pull in the generated Prisma namespace just for one check (mirrors
// programs/[id]/participants/route.ts).
function isPrismaError(error: unknown, code: string): boolean {
    return typeof error === "object" && error !== null && "code" in error
        && (error as { code: unknown }).code === code;
}

/**
 * DELETE /api/membership-ops/bg-attestations/[id] — sysadmin-only cleanup for a
 * BackgroundCheckAttestation the participant-merge route refuses to carry
 * forward ("Both attested the same background check", merge/route.ts): the
 * same human reviewed under two Person identities, and nothing else removes
 * the duplicate. Body: { reason: string } (mandatory, non-empty).
 *
 * Leaves OrgMembershipProcess.status untouched — see the PR body for the
 * process-status coupling this was checked against and why it's a no-op here.
 */
export const DELETE = withAuth<{ params: Promise<{ id: string }> }>(
    { roles: ["isSysadmin"] },
    async (req, auth, { params }) => {
        if (auth.type !== "session") return apiError("Unauthorized", 401);

        const id = Number((await params).id);
        if (!Number.isInteger(id)) return apiError("Invalid attestation id", 400);

        let body: { reason?: unknown };
        try {
            body = await req.json();
        } catch {
            return apiError("Invalid JSON", 400);
        }
        const reason = typeof body.reason === "string" ? body.reason.trim() : "";
        if (!reason) return apiError("A reason is required", 400);

        try {
            await prisma.$transaction(async (tx) => {
                const attestation = await tx.backgroundCheckAttestation.findUnique({ where: { id } });
                if (!attestation) throw new NotFoundError();

                // FOR UPDATE per attest()'s contract: without it a concurrent
                // attest()/overrideBlocked() attestation-set mutation on the same
                // process could interleave with this delete (e.g. a second APPROVE
                // clearing the check off a row we're mid-removing).
                await tx.$queryRaw`SELECT id FROM "OrgMembershipProcess" WHERE id = ${attestation.processId} FOR UPDATE`;

                await tx.backgroundCheckAttestation.delete({ where: { id } });
                await tx.auditLog.create({
                    data: {
                        actorId: auth.user.id,
                        action: "DELETE",
                        tableName: "BackgroundCheckAttestation",
                        affectedEntityId: id,
                        secondaryAffectedEntity: attestation.processId,
                        oldData: {
                            processId: attestation.processId,
                            reviewerId: attestation.reviewerId,
                            subjectPersonId: attestation.subjectPersonId,
                            result: attestation.result,
                            note: attestation.note,
                            isMarkedVolunteer: attestation.isMarkedVolunteer,
                            createdAt: attestation.createdAt,
                        },
                        newData: { reason },
                    },
                });
            });
            return NextResponse.json({ success: true });
        } catch (error) {
            if (error instanceof NotFoundError) return apiError("Attestation not found.", 404);
            // Concurrent double-delete of the same row: the loser's delete throws
            // P2025 (record to delete not found) — 404, not a 500.
            if (isPrismaError(error, "P2025")) return apiError("Attestation not found.", 404);
            await logBackendError(error, "DELETE /api/membership-ops/bg-attestations/[id]");
            return apiError("Internal Server Error", 500);
        }
    }
);
