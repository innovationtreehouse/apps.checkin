import { createHash, randomUUID } from "crypto";
import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";
import { withTx, type DbClient, type TxClient } from "@/lib/db-client";

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

function financeViewRow(view: FinanceView) {
    const viewedAt = view.viewedAt ?? new Date();
    return {
        viewedAt,
        actorId: view.actorId,
        role: view.role,
        endpoint: view.endpoint,
        params: view.params,
        recordIds: view.recordIds,
        rowCount: view.rowCount,
        window: financeViewWindow(viewedAt),
        viewKey: financeViewKey(view),
    };
}

/**
 * Record finance views in one insert statement. A repeat of the same view by the
 * same person in the same window is dropped by the unique index. Returns how many
 * rows were inserted.
 */
export async function recordFinanceViews(views: FinanceView[], db: DbClient = prisma): Promise<number> {
    if (views.length === 0) return 0;
    const { count } = await db.financeViewLog.createMany({ data: views.map(financeViewRow), skipDuplicates: true });
    return count;
}

/**
 * Record one finance view.
 * Throws on a database failure: the caller refuses the view rather than serve it unrecorded.
 */
export async function recordFinanceView(view: FinanceView, db: DbClient = prisma): Promise<void> {
    await recordFinanceViews([view], db);
}

// ---------------------------------------------------------------------------
// Page views: one row per page view, merged from the calls the browser tags
// (docs/in-design/FINANCE_VIEW_RECORD_IDS.md §4, §5).
// ---------------------------------------------------------------------------

/** Calls merge into a page view only within this span of its first call. */
export const PAGE_VIEW_MERGE_MS = 30 * 1000;

/** The `viewKey` prefix of a page-view row still within its merge span. */
export const OPEN_VIEW_KEY_PREFIX = "open:";

/** Advisory-lock namespace serialising one person's finance view writes. */
const ACTOR_LOCK_NAMESPACE = 0x46564c;

/** One record a view showed, as `Model:id`, with the marked field names it was sent. */
export interface FinanceViewRecord {
    ref: string;
    fields: string[];
}

/** One API call in a log row. `query` holds only the route's declared query parameters. */
export interface FinanceViewCallEntry {
    endpoint: string;
    path: string;
    query: Record<string, string>;
    role: string;
}

/** The browser's page-view tag: its page-view id and the page path it claims. */
export interface PageViewTag {
    id: string;
    path: string;
}

export interface FinanceViewCall extends FinanceViewCallEntry {
    actorId: number;
    records: FinanceViewRecord[];
    /** Null for an untagged call, and for one whose route may not fold into its claimed page. */
    pageView: PageViewTag | null;
    viewedAt?: Date;
}

/** Records merged by ref, each ref's fields deduplicated and sorted, refs sorted. */
export function unionRecords(...lists: readonly FinanceViewRecord[][]): FinanceViewRecord[] {
    const byRef = new Map<string, Set<string>>();
    for (const list of lists) {
        for (const { ref, fields } of list) {
            const set = byRef.get(ref) ?? new Set<string>();
            for (const field of fields) set.add(field);
            byRef.set(ref, set);
        }
    }
    return [...byRef.keys()].sort().map((ref) => ({ ref, fields: [...(byRef.get(ref) ?? [])].sort() }));
}

function canonicalCall(call: FinanceViewCallEntry): string {
    const query = Object.keys(call.query).sort().map((key) => [key, call.query[key]]);
    return JSON.stringify([call.endpoint, call.path, query, call.role]);
}

/** Calls in arrival order, an identical repeat listed once. */
export function unionCalls(...lists: readonly FinanceViewCallEntry[][]): FinanceViewCallEntry[] {
    const seen = new Set<string>();
    const out: FinanceViewCallEntry[] = [];
    for (const list of lists) {
        for (const call of list) {
            const key = canonicalCall(call);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ endpoint: call.endpoint, path: call.path, query: { ...call.query }, role: call.role });
        }
    }
    return out;
}

function sha256(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** A finished page-view row's key: its page path, records and their field names, never the page-view id. */
export function pageViewKey(pagePath: string, records: readonly FinanceViewRecord[]): string {
    return sha256(["page", pagePath, unionRecords([...records])]);
}

/** An untagged row's key: its calls, records and their field names. */
export function untaggedViewKey(calls: readonly FinanceViewCallEntry[], records: readonly FinanceViewRecord[]): string {
    return sha256(["call", unionCalls([...calls]).map(canonicalCall).sort(), unionRecords([...records])]);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `records` column read back; throws on a shape this writer never stores. */
export function parseRecords(value: unknown): FinanceViewRecord[] {
    if (value === null || value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("FinanceViewLog.records is not a list");
    return value.map((item) => {
        if (!isPlainObject(item) || typeof item.ref !== "string" || !isStringArray(item.fields)) {
            throw new Error("FinanceViewLog.records holds a malformed record");
        }
        return { ref: item.ref, fields: item.fields };
    });
}

/** The `calls` column read back; throws on a shape this writer never stores. */
export function parseCalls(value: unknown): FinanceViewCallEntry[] {
    if (value === null || value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("FinanceViewLog.calls is not a list");
    return value.map((item) => {
        if (
            !isPlainObject(item) ||
            typeof item.endpoint !== "string" ||
            typeof item.path !== "string" ||
            typeof item.role !== "string" ||
            !isPlainObject(item.query) ||
            !Object.values(item.query).every((v) => typeof v === "string")
        ) {
            throw new Error("FinanceViewLog.calls holds a malformed call");
        }
        const query: Record<string, string> = {};
        for (const [key, v] of Object.entries(item.query)) if (typeof v === "string") query[key] = v;
        return { endpoint: item.endpoint, path: item.path, query, role: item.role };
    });
}

function recordColumns(records: FinanceViewRecord[]) {
    return { records: records.map((r) => ({ ref: r.ref, fields: r.fields })), recordIds: records.map((r) => r.ref), recordCount: records.length };
}

/** The `calls` column as stored. */
function callsColumn(calls: readonly FinanceViewCallEntry[]): Prisma.InputJsonObject[] {
    return calls.map((c) => ({ endpoint: c.endpoint, path: c.path, query: { ...c.query }, role: c.role }));
}

function callEntry(call: FinanceViewCall): FinanceViewCallEntry {
    return { endpoint: call.endpoint, path: call.path, query: call.query, role: call.role };
}

/** Where a tagged call goes, given its id's first row and the person's open row for it. */
export type PageViewDisposition = "untagged" | "merge" | "new";

export function pageViewDisposition(
    call: { actorId: number; pageView: PageViewTag },
    firstUse: { actorId: number; pagePath: string | null } | null,
    hasOpenRow: boolean,
): PageViewDisposition {
    if (firstUse && (firstUse.actorId !== call.actorId || firstUse.pagePath !== call.pageView.path)) return "untagged";
    return hasOpenRow ? "merge" : "new";
}

/**
 * Close this person's page-view rows whose merge span has passed before `at`.
 * A closed row takes its content key. When an earlier row of the same person in
 * the same window already holds that key, the closed row's calls are added to it
 * and the closed row is removed: the two showed the same records and fields on
 * the same page, so nothing they recorded is lost.
 */
async function closeFinishedPageViews(tx: TxClient, actorId: number, at: Date): Promise<void> {
    const finished = await tx.financeViewLog.findMany({
        where: {
            actorId,
            viewKey: { startsWith: OPEN_VIEW_KEY_PREFIX },
            viewedAt: { lt: new Date(at.getTime() - PAGE_VIEW_MERGE_MS) },
        },
        orderBy: [{ viewedAt: "asc" }, { id: "asc" }],
    });
    for (const row of finished) {
        const records = parseRecords(row.records);
        const viewKey = pageViewKey(row.pagePath ?? "", records);
        const earlier = await tx.financeViewLog.findFirst({ where: { actorId, window: row.window, viewKey } });
        if (!earlier) {
            await tx.financeViewLog.update({ where: { id: row.id }, data: { viewKey } });
            continue;
        }
        const merged = unionRecords(parseRecords(earlier.records), records);
        await tx.financeViewLog.update({
            where: { id: earlier.id },
            data: { calls: callsColumn(unionCalls(parseCalls(earlier.calls), parseCalls(row.calls))), ...recordColumns(merged) },
        });
        await tx.financeViewLog.delete({ where: { id: row.id } });
    }
}

async function writeUntagged(tx: TxClient, call: FinanceViewCall, at: Date): Promise<void> {
    const calls = [callEntry(call)];
    const records = unionRecords(call.records);
    await tx.financeViewLog.createMany({
        data: [{
            viewedAt: at,
            actorId: call.actorId,
            role: call.role,
            calls: callsColumn(calls),
            ...recordColumns(records),
            window: financeViewWindow(at),
            viewKey: untaggedViewKey(calls, records),
        }],
        skipDuplicates: true,
    });
}

/**
 * Record one audited API call. A tagged call merges into its page view's row:
 * the same person's calls with that page-view id, claiming the id's first page
 * path, within {@link PAGE_VIEW_MERGE_MS} of the row's first call. Merging only
 * adds calls, records and field names. A call that fails a limit, or carries no
 * tag, writes a row of its own.
 * Throws on a database failure: the caller refuses the view rather than serve it unrecorded.
 */
export async function recordFinanceViewCall(call: FinanceViewCall, db: DbClient = prisma): Promise<void> {
    const at = call.viewedAt ?? new Date();
    await withTx(db, async (tx) => {
        // One person's calls are serialised, so two calls of one page view never both start a row.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ACTOR_LOCK_NAMESPACE}::int, ${call.actorId}::int)`;
        await closeFinishedPageViews(tx, call.actorId, at);

        const tag = call.pageView;
        if (!tag) return writeUntagged(tx, call, at);

        // Serialises first use of an id across people.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`finance-page-view:${tag.id}`}))`;
        const firstUse = await tx.financeViewLog.findFirst({
            where: { pageViewId: tag.id },
            orderBy: [{ viewedAt: "asc" }, { id: "asc" }],
            select: { actorId: true, pagePath: true },
        });
        const open = await tx.financeViewLog.findFirst({
            where: { pageViewId: tag.id, actorId: call.actorId, viewKey: { startsWith: OPEN_VIEW_KEY_PREFIX } },
            orderBy: [{ viewedAt: "desc" }, { id: "desc" }],
        });

        switch (pageViewDisposition({ actorId: call.actorId, pageView: tag }, firstUse, open !== null)) {
            case "untagged":
                return writeUntagged(tx, call, at);
            case "merge": {
                if (!open) throw new Error("page-view merge without an open row");
                await tx.financeViewLog.update({
                    where: { id: open.id },
                    data: {
                        calls: callsColumn(unionCalls(parseCalls(open.calls), [callEntry(call)])),
                        ...recordColumns(unionRecords(parseRecords(open.records), call.records)),
                    },
                });
                return;
            }
            case "new":
                await tx.financeViewLog.create({
                    data: {
                        viewedAt: at,
                        actorId: call.actorId,
                        role: call.role,
                        pagePath: tag.path,
                        pageViewId: tag.id,
                        calls: callsColumn([callEntry(call)]),
                        ...recordColumns(unionRecords(call.records)),
                        window: financeViewWindow(at),
                        viewKey: `${OPEN_VIEW_KEY_PREFIX}${randomUUID()}`,
                    },
                });
        }
    });
}
