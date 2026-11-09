import type { FailureReport } from "@checkin/component-kit";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";

/**
 * Counts each fault code a QuickBooks lane's report carries under the report's kind. Runs on the
 * shared client, outside any lane transaction; a failed write is logged and dropped, never thrown.
 */
export async function recordFaultCodes(report: FailureReport): Promise<void> {
    const now = new Date();
    try {
        for (const code of new Set(report.faultCodes)) {
            await prisma.qboFaultCodeSeen.upsert({
                where: { code_kind: { code, kind: report.kind } },
                create: { code, kind: report.kind, count: 1, firstSeenAt: now, lastSeenAt: now, lastLane: report.lane },
                update: { count: { increment: 1 }, lastSeenAt: now, lastLane: report.lane },
            });
        }
    } catch (err) {
        logger.error("[qbo fault codes] write failed:", err);
    }
}
