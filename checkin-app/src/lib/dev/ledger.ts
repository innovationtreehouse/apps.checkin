import prisma from "@/lib/prisma";
import { config } from "@/lib/config";

/**
 * The dev-instance activity ledger (docs/ops/dev-instance.md, "The ledger").
 *
 * Records the last login / impersonate / macro / reset by REAL human identity so a shared dev
 * instance shows who tested/reset last, so nobody clobbers a colleague's scenario. The DevLedger table
 * lives only in checkin_dev; these helpers are no-ops in prod by construction.
 */

export interface LedgerEntry {
    action: string;
    realActor: string;
    detail: string | null;
    createdAt: Date;
}

/**
 * Append a ledger row. Best-effort: a ledger write must NEVER break the action it accompanies
 * (a login or a reset still succeeds even if the audit insert fails), so errors are swallowed
 * and logged rather than thrown.
 */
export async function recordLedger(
    action: string,
    realActor: string,
    detail?: string | null,
): Promise<void> {
    if (config.isProd()) return;
    try {
        await prisma.devLedger.create({
            data: { action, realActor, detail: detail ?? null },
        });
    } catch (e) {
        console.error("[dev-ledger] failed to record", action, e);
    }
}

/** Most-recent entries (newest first) for the dashboard activity line + reset confirm dialog. */
export async function recentActivity(limit = 5): Promise<LedgerEntry[]> {
    if (config.isProd()) return [];
    try {
        return await prisma.devLedger.findMany({
            orderBy: { createdAt: "desc" },
            take: limit,
            select: { action: true, realActor: true, detail: true, createdAt: true },
        });
    } catch (e) {
        console.error("[dev-ledger] failed to read", e);
        return [];
    }
}
