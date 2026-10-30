import { createHash } from "crypto";
import prisma from "@/lib/prisma";
import type { DbClient } from "@/lib/db-client";

/** Repeat views by the same person of the same records within this span collapse to one row. */
export const FINANCE_VIEW_WINDOW_MS = 15 * 60 * 1000;

/** A route's path parameters, e.g. `{ id: "r_123" }`; a catch-all segment is an array. */
export type FinanceViewParams = Record<string, string | string[]>;

export interface FinanceView {
    actorId: number;
    /** The role the view was chosen under; null only for rows copied from the donor-read audit. */
    role: string | null;
    /** The registry key, e.g. `GET /api/receipts/[id]`. */
    endpoint: string;
    params: FinanceViewParams;
    recordIds: string[];
    rowCount: number;
    viewedAt?: Date;
}

/** The start of the fifteen-minute UTC window `viewedAt` falls in. */
export function financeViewWindow(viewedAt: Date): Date {
    return new Date(Math.floor(viewedAt.getTime() / FINANCE_VIEW_WINDOW_MS) * FINANCE_VIEW_WINDOW_MS);
}

/**
 * Hex SHA-256 identifying which records a view showed through which endpoint.
 * Param keys and record ids are sorted first, so arrival order never changes the key.
 */
export function financeViewKey(view: Pick<FinanceView, "endpoint" | "params" | "recordIds">): string {
    const params = Object.keys(view.params).sort().map((key) => [key, view.params[key]]);
    const recordIds = [...view.recordIds].sort();
    return createHash("sha256").update(JSON.stringify([view.endpoint, params, recordIds])).digest("hex");
}

/**
 * Record one finance view. A repeat of the same view by the same person in the
 * same window is dropped by the unique index, in the one insert statement.
 * Throws on a database failure: the caller refuses the view rather than serve it unrecorded.
 */
export async function recordFinanceView(view: FinanceView, db: DbClient = prisma): Promise<void> {
    const viewedAt = view.viewedAt ?? new Date();
    await db.financeViewLog.createMany({
        data: [{
            viewedAt,
            actorId: view.actorId,
            role: view.role,
            endpoint: view.endpoint,
            params: view.params,
            recordIds: view.recordIds,
            rowCount: view.rowCount,
            window: financeViewWindow(viewedAt),
            viewKey: financeViewKey(view),
        }],
        skipDuplicates: true,
    });
}
