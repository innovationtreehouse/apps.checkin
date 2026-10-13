import prisma from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { DUES_SETTLED_PERSON_WHERE } from "@/lib/orgMembership";
import { handler, notFound, badRequest } from "@/security/handler";
import { LIVE_PERSON } from "@/lib/person/filters";
import { searchId } from "@/lib/searchId";

// Admission + field stripping declared in src/security/registry.ts under
// 'GET /api/programs/[id]/eligible-participants'. A staff directory SEARCH for
// people NOT yet in the program; it returns names only (no contact or age data,
// youth included), and matches on name or id, never email.
export const GET = handler<{ id: string }>('GET /api/programs/[id]/eligible-participants', async ({ req, params }) => {
    const programId = parseInt(params.id, 10);
    if (isNaN(programId)) throw badRequest('Invalid program ID');

    const currentProgram = await prisma.program.findUnique({ where: { id: programId } });
    if (!currentProgram) throw notFound('Program not found');

    // new URL(req.url) (not req.nextUrl) so the handler works on a plain Request too.
    const q = new URL(req.url).searchParams.get("q") || "";

    const andClauses: Prisma.PersonWhereInput[] = [
        {
            NOT: {
                OR: [
                    { programParticipants: { some: { programId } } },
                    { programVolunteers: { some: { programId } } }
                ]
            }
        }
    ];

    if (q) {
        // A bare number is also an id lookup, OR'd with the text match — the
        // participant tables print the id column.
        const idQuery = searchId(q);
        andClauses.push({
            OR: [
                { name: { contains: q, mode: 'insensitive' } },
                ...(idQuery !== null ? [{ id: idQuery }] : []),
            ]
        });
    }

    // A household whose dues are paid and whose background check is still with the
    // board is eligible for members-only programs — same rule as the catalog,
    // detail, and enrollment gates.
    if (currentProgram.orgMemberOnly) {
        andClauses.push(DUES_SETTLED_PERSON_WHERE);
    }

    const members = await prisma.person.findMany({
        where: { AND: andClauses, ...LIVE_PERSON },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
        take: 50
    });

    return { Person: members };
});
