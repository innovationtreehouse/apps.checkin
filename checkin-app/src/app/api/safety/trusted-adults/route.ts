import prisma from "@/lib/prisma";
import { leadMembersWhere } from "@/lib/household/leads";
import { handler } from "@/security/handler";

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
            household: { archivedAt: null },
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
            household: { select: { id: true, name: true, householdMembers: { where: leadMembersWhere(), select: { id: true, name: true, email: true } } } },
            trustedAdultPerson: { select: { id: true, name: true, email: true, householdId: true } },
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
                    familyReply: true,
                    createdAt: true,
                },
            },
        },
    });
    return { TrustedAdult: links };
});
