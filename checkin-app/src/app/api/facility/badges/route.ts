import prisma from "@/lib/prisma";
import { handler } from "@/security/handler";

// Registry-governed (GET /api/facility/badges): admission anyRole
// sysadmin/board; envelope 'badges'. RawBadgeLog rows are internal/personal
// tier and nested person email is pii — all covered by the admin everyones
// band. Same query, same take-200 shape.
export const GET = handler('GET /api/facility/badges', async () => {
    const badges = await prisma.rawBadgeLog.findMany({
        take: 200,
        orderBy: { timestamp: "desc" },
        include: {
            person: {
                select: { name: true, email: true },
            },
        },
    });

    return { RawBadgeLog: badges };
});
