import prisma from "@/lib/prisma";
import { handler } from "@/security/handler";

export const dynamic = "force-dynamic";

/**
 * Board-only read-only list of every background-check attestation — "who signed
 * off what". Returns attestations newest-first with the reviewer, the subject
 * (when named), the household, the result, and the process kind.
 */
export const GET = handler('GET /api/membership-audit/bg-attestations', async () => {
    const rows = await prisma.backgroundCheckAttestation.findMany({
        select: {
            id: true,
            result: true,
            createdAt: true,
            reviewer: { select: { id: true, name: true } },
            subjectPerson: { select: { id: true, name: true } },
            process: {
                select: {
                    id: true,
                    kind: true,
                    status: true,
                    bgClearedAt: true,
                    subjectPerson: { select: { id: true, name: true, householdId: true, household: { select: { id: true, name: true } } } },
                    orgMembership: { select: { household: { select: { id: true, name: true } } } },
                },
            },
        },
        orderBy: { createdAt: "desc" },
    });

    return { BackgroundCheckAttestation: rows };
});
