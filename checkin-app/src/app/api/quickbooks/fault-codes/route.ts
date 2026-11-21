import prisma from "@/lib/prisma";
import { handler } from "@/security/handler";

/** Every QuickBooks fault code the app has counted, newest last-seen first. The set is a few dozen rows, so no paging. */
export const GET = handler('GET /api/quickbooks/fault-codes', async () => ({
    QboFaultCodeSeen: await prisma.qboFaultCodeSeen.findMany({
        select: { code: true, kind: true, count: true, firstSeenAt: true, lastSeenAt: true, lastLane: true },
        orderBy: [{ lastSeenAt: 'desc' }, { code: 'asc' }, { kind: 'asc' }],
    }),
}));
