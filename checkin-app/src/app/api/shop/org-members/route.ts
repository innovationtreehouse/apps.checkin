import prisma from "@/lib/prisma";
import { handler } from "@/security/handler";
import { ACTIVE_ORG_MEMBER_PERSON_WHERE } from "@/lib/orgMembership";

export const dynamic = 'force-dynamic';

export const GET = handler('GET /api/shop/org-members', async () => {
    // Select email too: admins/board are granted everyones:pii and see it. For a
    // certifier the view holds only member+public, so the stripper drops email
    // and keeps name. Field-stripping — not the query — decides who sees what.
    const members = await prisma.person.findMany({
        where: ACTIVE_ORG_MEMBER_PERSON_WHERE,
        select: {
            id: true,
            name: true,
            email: true,
        },
        orderBy: {
            name: 'asc'
        }
    });

    return { Person: members };
});
