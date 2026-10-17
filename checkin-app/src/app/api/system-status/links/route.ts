import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { handler } from "@/security/handler";

// Link Status data source: recent external-integration failures.
// Registry-governed (GET /api/system-status/links): admission anyRole
// sysadmin/board; envelope 'errors' (response key kept for the existing UI).
// IntegrationErrorLog is wholly internal tier — covered by the admin band.
export const GET = handler('GET /api/system-status/links', async () => {
    // 90-day TTL purge on read (admin opening the tab). ponytail: no cron needed.
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    prisma.integrationErrorLog
        .deleteMany({ where: { timestamp: { lt: ninetyDaysAgo } } })
        .catch((err: unknown) => logger.error("Failed to purge old integration errors:", err));

    const errors = await prisma.integrationErrorLog.findMany({
        // nulls:"first" — unresolved (resolvedAt null) sort first; PG default is NULLS LAST.
        orderBy: [{ resolvedAt: { sort: "asc", nulls: "first" } }, { timestamp: "desc" }],
        take: 200,
    });

    return { IntegrationErrorLog: errors };
});
