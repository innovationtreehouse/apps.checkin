import "dotenv/config";
import { Pool } from "pg";
import { z } from "zod";
import prisma from "../src/lib/prisma";
import { recordFinanceViews, type FinanceView } from "../src/lib/finance/financeViewLog";

/**
 * One-time copy of the bulk-donation donor-read audit into FinanceViewLog
 * (docs/in-design/B11_FINANCE_VIEW_AUDIT-migration.md).
 *
 *   npx tsx scripts/copy-donor-reads.ts --cutoff <ISO time> [--commit]
 *
 * Reads every DONOR_DATA_READ row in the bulk-donation database (BULK_DONATION_DATABASE_URL)
 * written before --cutoff, and writes each as a finance view in the checkin database
 * (DATABASE_URL), in batches. --cutoff is the production deploy time of the handler's own
 * finance-view logging; later rows are already in the log. Defaults to a DRY RUN that only
 * counts; --commit writes. A rerun adds nothing: the writer's insert skips duplicates.
 */

const BATCH_SIZE = 500;

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

// occurred_at is a UTC timestamp without zone; epoch milliseconds avoid pg's local-time parsing.
const SELECT_BATCH = `
    SELECT id,
           entity_id AS "entityId",
           actor_user_id AS "actorUserId",
           payload,
           (extract(epoch FROM occurred_at) * 1000)::float8 AS "occurredAtMs"
      FROM workflow_events
     WHERE event_type = 'DONOR_DATA_READ'
       AND occurred_at < ($1::timestamptz AT TIME ZONE 'UTC')
       AND id > $2
     ORDER BY id
     LIMIT $3`;

type SourceRow = Omit<DonorReadRow, "occurredAt"> & { occurredAtMs: number };

async function main() {
    const cutoff = parseCutoff(process.argv.slice(2));
    const commit = process.argv.includes("--commit");
    const sourceUrl = process.env.BULK_DONATION_DATABASE_URL;
    if (!sourceUrl) throw new Error("BULK_DONATION_DATABASE_URL is not set.");

    const source = new Pool({ connectionString: sourceUrl, max: 1 });
    let total = 0;
    let copied = 0;
    let skipped = 0;
    let inserted = 0;
    try {
        let afterId = 0;
        for (;;) {
            const { rows } = await source.query<SourceRow>(SELECT_BATCH, [cutoff.toISOString(), afterId, BATCH_SIZE]);
            if (rows.length === 0) break;
            const views: FinanceView[] = [];
            for (const { occurredAtMs, ...row } of rows) {
                const view = toFinanceView({ ...row, occurredAt: new Date(Math.round(occurredAtMs)) });
                if (view) views.push(view);
            }
            total += rows.length;
            copied += views.length;
            skipped += rows.length - views.length;
            if (commit) inserted += await recordFinanceViews(views);
            afterId = rows[rows.length - 1].id;
        }
    } finally {
        await source.end();
        await prisma.$disconnect();
    }

    console.log(`${commit ? "Copied" : "DRY RUN — would copy"} donor-read rows before ${cutoff.toISOString()}:`);
    console.log(`  total:    ${total}`);
    console.log(`  copied:   ${copied}`);
    console.log(`  skipped:  ${skipped} (no actor; left in workflow_events)`);
    if (commit) console.log(`  inserted: ${inserted} (the rest repeat a view in its window, or were copied before)`);
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}
