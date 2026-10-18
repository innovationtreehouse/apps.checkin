import prisma from "@/lib/prisma";
import { isPrismaError } from "@/lib/prismaUniqueViolation";
import { handler, ApiResponseError, badRequest, notFound, unauthorized } from "@/security/handler";
import { logBackendError } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/membership-ops/bg-attestations/[id] — cleanup for a
 * BackgroundCheckAttestation the participant-merge route refuses to carry
 * forward ("Both attested the same background check", lib/person/merge/plan.ts): the
 * same human reviewed under two Person identities, and nothing else removes
 * the duplicate. Body: { reason: string } (mandatory, non-empty). Who may call
 * it is the registry entry's grant.
 *
 * Leaves OrgMembershipProcess.status untouched — see the PR body for the
 * process-status coupling this was checked against and why it's a no-op here.
 */
export const DELETE = handler<{ id: string }>("DELETE /api/membership-ops/bg-attestations/[id]", async ({ req, auth, params }) => {
    if (auth.type !== "session") throw unauthorized();

    const id = Number(params.id);
    if (!Number.isInteger(id)) throw badRequest("Invalid attestation id");

    let body: { reason?: unknown };
    try {
        body = await req.json();
    } catch {
        throw badRequest("Invalid JSON");
    }
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) throw badRequest("A reason is required");

    try {
        await prisma.$transaction(async (tx) => {
            const attestation = await tx.backgroundCheckAttestation.findUnique({ where: { id } });
            if (!attestation) throw notFound("Attestation not found.");

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
                        isMarkedVolunteerFamily: attestation.isMarkedVolunteerFamily,
                        createdAt: attestation.createdAt,
                    },
                    newData: { reason },
                },
            });
        });
    } catch (error) {
        // Concurrent double-delete of the same row: the loser's delete throws
        // P2025 (record to delete not found) — 404, not a 500.
        if (isPrismaError(error, "P2025")) throw notFound("Attestation not found.");
        if (!(error instanceof ApiResponseError)) {
            await logBackendError(error, "DELETE /api/membership-ops/bg-attestations/[id]");
        }
        throw error;
    }
    return {};
});
