import prisma from "@/lib/prisma";
import { handler } from "@/security/handler";

// Registry-governed (GET /api/system-status/unsynced-scans): admission anyRole
// sysadmin/board/keyholder (Q15; operations stay out — #1633); envelope 'scans'.
//
// The review queue (docs/rules/attendance-checkin.md, kiosk resilience):
// RawBadgeLog rows a replay
// PARKED instead of toggling (reviewReason set by /api/scan) and that nobody
// has dismissed yet.
//
// The select is the whole minimization story: person is narrowed to id + name,
// both public-tier, so no email or phone is in the bag at all and the registry
// grant carries no pii leg to strip one with.
export const GET = handler('GET /api/system-status/unsynced-scans', async () => {
    const scans = await prisma.rawBadgeLog.findMany({
        where: { reviewReason: { not: null }, reviewedAt: null },
        select: {
            id: true,
            timestamp: true,
            location: true,
            reviewReason: true,
            person: { select: { id: true, name: true } },
        },
        orderBy: { timestamp: "desc" },
        take: 100,
    });
    return { RawBadgeLog: scans };
});
