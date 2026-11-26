import prisma from "@/lib/prisma";
import { handler } from "@/security/handler";
import { openProcess } from "@/lib/membership/lifecycle";
import { isNotRenewingRenewal } from "@/lib/membership/notRenewing";

export const dynamic = "force-dynamic";

/**
 * GET /api/membership-ops/applications — in-flight membership applications for the board.
 * Every open process, with its household (or, for a per-person process,
 * its subject person) + external-phase flags.
 *
 * Field visibility is governed by the security registry (isSysadmin/board get the
 * full applicant PII; anyone else admitted would be stripped to public). The bag
 * is keyed by the model name so the stripper can classify it; the 'processes'
 * envelope preserves the response shape consumers expect.
 *
 * ?archived=1 flips to the board's recovery view: only ARCHIVED rows, so a
 * wrongly-archived application can be found and restored (unarchive route).
 *
 * Each row carries `notRenewing`: true for a renewal opened for the year its
 * household has said it won't renew into.
 */
export const GET = handler("GET /api/membership-ops/applications", async ({ req }) => {
    const archived = new URL(req.url).searchParams.get("archived") === "1";
    const processes = await prisma.orgMembershipProcess.findMany({
        where: archived ? { status: "ARCHIVED" } : openProcess.where,
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            kind: true,
            status: true,
            createdAt: true,
            zohoEnvelopeId: true,
            contractSignedAt: true,
            bgConsentAt: true,
            bgClearedAt: true,
            paidAt: true,
            membershipYear: true,
            attestations: { select: { id: true, result: true, subjectPersonId: true, isMarkedVolunteerFamily: true } },
            requestedForHouseholdId: true,
            subjectPerson: { select: { id: true, name: true, householdId: true } },
            orgMembership: {
                select: {
                    householdId: true,
                    isVolunteerFamily: true,
                    household: {
                        select: {
                            name: true,
                            // The leads here are the selectable subjects of a board force-approve.
                            householdMembers: { select: { id: true, name: true, email: true, isHouseholdLead: true } },
                        },
                    },
                },
            },
        },
    });

    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 }, select: { orgMembershipYearBoundary: true } });
    const noted = await prisma.orgMembership.findMany({
        where: { notRenewingYear: { not: null } },
        select: { householdId: true, notRenewingYear: true },
    });
    const notedYearOf = new Map(noted.map((m) => [m.householdId, m.notRenewingYear]));

    const rows = processes.map((p) => ({
        ...p,
        notRenewing: !!p.orgMembership
            && isNotRenewingRenewal(p, notedYearOf.get(p.orgMembership.householdId) ?? null, settings?.orgMembershipYearBoundary),
    }));
    return { MembershipApplicationRow: rows };
});
