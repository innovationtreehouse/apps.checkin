import prisma from "@/lib/prisma";
import { handler } from "@/security/handler";
import { LIVE_PERSON } from "@/lib/person/filters";
import { birthCutoff, memberYearStarts } from "@/lib/programYear";

export const dynamic = "force-dynamic";

/**
 * Board-only, read-only roster of the org's non-lead household members who are 18
 * or older as of a member-year start — the current one and the next, so the board
 * can see both who is already an adult this year and who ages in on the coming
 * boundary. Age is judged as-of each boundary, never as-of today.
 *
 * Household leads are excluded: this is the "child of the signer turns 18" list,
 * and a lead is the signer. Program enrollment rides along per row rather than
 * scoping the query — students in non-member households belong on the roster too,
 * and the view differentiates them instead of dropping them.
 *
 * People with no DOB and no 25+ declaration ride along with a null dateOfBirth:
 * their age is unknown, so the page counts them as a hygiene note instead of
 * placing them in the table.
 *
 * Ships the classified INPUTS (dateOfBirth + the year boundary) and lets the page
 * derive both as-of ages: the stripper drops ad-hoc computed fields, so an
 * `ageAtNext` on the row would never reach the wire.
 *
 * LIVE_PERSON is load-bearing — a merged-away person keeps its row as a tombstone
 * and would otherwise show up as a second entry for someone already listed.
 */
export const GET = handler('GET /api/membership-audit/turning-18', async () => {
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
    // No configured boundary means there is no member year to judge against; the
    // page says so rather than rendering an age nobody chose the basis for.
    if (!settings?.orgMembershipYearBoundary) return { BoardSettings: settings, Person: [] };

    const { next } = memberYearStarts(settings.orgMembershipYearBoundary, new Date());

    const people = await prisma.person.findMany({
        where: {
            ...LIVE_PERSON,
            isHouseholdLead: false,
            OR: [
                // 18 by the NEXT boundary is the superset — anyone already 18 at the
                // current one clears it too, and the two rendered ages tell them apart.
                { dateOfBirth: { lte: birthCutoff(next) } },
                // No DOB and no 25+ declaration is age UNKNOWN, not age 26+ (the purge
                // that strips a DOB always sets isDeclaredAdult). NULL never satisfies
                // the cutoff, so without this arm a 17-year-old with no birthdate on
                // file — exactly who this roster is for — would be silently absent.
                { dateOfBirth: null, isDeclaredAdult: false },
            ],
        },
        select: {
            id: true,
            name: true,
            dateOfBirth: true,
            household: { select: { id: true, name: true } },
            programParticipants: {
                where: { program: { phase: { not: "FINISHED" } } },
                select: { program: { select: { id: true, name: true } } },
            },
        },
        orderBy: { name: "asc" },
    });

    return { BoardSettings: settings, Person: people };
});
