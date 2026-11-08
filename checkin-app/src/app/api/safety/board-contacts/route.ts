import prisma from "@/lib/prisma";
import { handler } from "@/security/handler";

// Emergency board contact sheet for the front desk. Keyholders receive email +
// phone here — deliberate and owner-confirmed, declared as the registry's
// 'keyholders:pii' grant rather than hand-rolled in this query. The select
// stays tight as defense in depth: dateOfBirth and googleId must never enter
// this response even for a sysadmin caller whose view would grant them.
export const GET = handler('GET /api/safety/board-contacts', async () => {
    const members = await prisma.person.findMany({
        where: { isBoardMember: true },
        select: { id: true, name: true, phone: true, email: true },
        orderBy: { name: "asc" },
    });
    return { Person: members };
});
