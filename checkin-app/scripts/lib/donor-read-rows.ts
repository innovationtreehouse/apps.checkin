import { z } from "zod";
import type { FinanceView } from "../../src/lib/finance/financeViewLog";

/** Row mapping and arguments for the donor-read copy (scripts/copy-donor-reads.ts). */

export interface DonorReadRow {
    id: number;
    entityId: string | null;
    actorUserId: number | null;
    payload: string | null;
    occurredAt: Date;
}

const payloadSchema = z.object({
    route: z.string().min(1),
    ids: z.array(z.union([z.number(), z.string()])).optional(),
    count: z.number().int().nonnegative().optional(),
});

/** The finance view a donor-read row records, or null when the row names no actor. */
export function toFinanceView(row: DonorReadRow): FinanceView | null {
    if (row.actorUserId === null) return null;
    let raw: unknown;
    try {
        raw = JSON.parse(row.payload ?? "");
    } catch {
        throw new Error(`Donor-read row ${row.id} has an unreadable payload`);
    }
    const parsed = payloadSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`Donor-read row ${row.id} has an unreadable payload`);
    const { route, ids, count } = parsed.data;
    const recordIds = row.entityId !== null ? [row.entityId] : (ids ?? []).map(String);
    return {
        actorId: row.actorUserId,
        role: null,
        endpoint: route,
        params: {},
        recordIds,
        rowCount: count ?? recordIds.length,
        viewedAt: row.occurredAt,
    };
}

/** The required --cutoff, an ISO time with an explicit zone. */
export function parseCutoff(argv: string[]): Date {
    const i = argv.indexOf("--cutoff");
    const value = i >= 0 ? argv[i + 1] : undefined;
    if (!value) throw new Error("--cutoff <ISO time> is required: the production deploy time of PR 2 (#2683).");
    if (!/(Z|[+-]\d{2}:?\d{2})$/.test(value)) throw new Error(`--cutoff must name its time zone (e.g. 2026-10-28T17:04:00Z): ${value}`);
    const cutoff = new Date(value);
    if (Number.isNaN(cutoff.getTime())) throw new Error(`--cutoff is not a valid time: ${value}`);
    return cutoff;
}
