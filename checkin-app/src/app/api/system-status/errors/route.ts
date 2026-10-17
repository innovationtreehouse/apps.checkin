import prisma from "@/lib/prisma";
import { handler } from "@/security/handler";

// Registry-governed (GET /api/system-status/errors): admission anyRole
// sysadmin/board; envelope 'errors'. ErrorLog is wholly internal tier —
// covered by the admin everyones band. Same query, same take-100 shape.
export const GET = handler('GET /api/system-status/errors', async () => {
    const errors = await prisma.errorLog.findMany({
        orderBy: { timestamp: "desc" },
        take: 100,
    });
    return { ErrorLog: errors };
});
