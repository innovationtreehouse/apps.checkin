import prisma from "@/lib/prisma";
import { handler } from "@/security/handler";
import { LIVE_PERSON } from "@/lib/person/filters";

export const dynamic = "force-dynamic";

/**
 * GET /api/safety/trusted-adults — the board's review queue: every link with a
 * review awaiting board action, awaiting the subject, or expired (needing
 * renewal). Exposes subject + counterparty PII, so only isSysadmin/board are
 * admitted and the field grant is explicit per role in the registry.
 */
export const GET = handler("GET /api/safety/trusted-adults", async () => {
    const links = await prisma.trustedAdult.findMany({
        where: {
            reviews: { some: { status: { in: ["PENDING_BOARD_REVIEW", "PENDING_SUBJECT_ACTION", "EXPIRED"] } } },
        },
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            householdId: true,
            trustedAdultPersonId: true,
            trustedAdultName: true,
            trustedAdultPhone: true,
            trustedAdultEmail: true,
            familyContext: true,
            origin: true,
            createdAt: true,
            household: { select: { id: true, name: true, householdMembers: { where: { isHouseholdLead: true, ...LIVE_PERSON }, select: { id: true, name: true, email: true } } } },
            trustedAdultPerson: { select: { id: true, name: true, email: true } },
            reviews: {
                orderBy: { id: "desc" },
                select: {
                    id: true,
                    trustedAdultId: true,
                    householdId: true,
                    kind: true,
                    status: true,
                    decision: true,
                    decisionNote: true,
                    sharedNote: true,
                    effectiveFrom: true,
                    reviewBy: true,
                    proposedName: true,
                    proposedPhone: true,
                    proposedEmail: true,
                    proposedContext: true,
                    createdAt: true,
                },
            },
        },
    });
    return { TrustedAdult: links };
});
