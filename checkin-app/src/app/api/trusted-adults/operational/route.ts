import prisma from "@/lib/prisma";
import { handler, unauthorized } from "@/security/handler";
import { LIVE_PERSON } from "@/lib/person/filters";
import { AUTHORIZED_REVIEW } from "@/lib/trusted-adult/filters";
import type { Prisma } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

/**
 * GET /api/trusted-adults/operational — approved trusted adults with the board's
 * shared note, for the people who act on them: keyholders (global) and program
 * leads (the households whose children are in their programs). Board/isSysadmin see
 * all. The registry view strips familyContext (pii) + internal notes; this handler
 * additionally restricts WHICH rows are returned so existence isn't leaked.
 */
export const GET = handler("GET /api/trusted-adults/operational", async ({ auth }) => {
    if (auth.type !== "session") throw unauthorized();
    const u = auth.user;
    const privileged = u.isSysadmin || u.isBoardMember || u.isKeyholder;

    const where: Prisma.TrustedAdultWhereInput = { reviews: { some: AUTHORIZED_REVIEW } };

    if (!privileged) {
        // Program leads: households of children enrolled in programs they lead or core-vol.
        const led = await prisma.program.findMany({
            where: { leadMentorId: u.id },
            select: { participants: { where: { person: LIVE_PERSON }, select: { person: { select: { householdId: true } } } } },
        });
        const coreVol = await prisma.programVolunteer.findMany({
            where: { personId: u.id, isCore: true },
            select: { program: { select: { participants: { where: { person: LIVE_PERSON }, select: { person: { select: { householdId: true } } } } } } },
        });
        const households = new Set<number>();
        for (const p of led) for (const pp of p.participants) households.add(pp.person.householdId);
        for (const v of coreVol) for (const pp of v.program.participants) households.add(pp.person.householdId);
        if (households.size === 0) return { TrustedAdult: [] };
        where.householdId = { in: [...households] };
    }

    const trustedAdults = await prisma.trustedAdult.findMany({
        where,
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            householdId: true,
            trustedAdultName: true,
            trustedAdultPhone: true,
            trustedAdultEmail: true,
            household: { select: { id: true, name: true } },
            reviews: {
                where: AUTHORIZED_REVIEW,
                orderBy: { id: "desc" },
                take: 1,
                select: { id: true, householdId: true, status: true, sharedNote: true, reviewBy: true },
            },
        },
    });
    return { TrustedAdult: trustedAdults };
});
