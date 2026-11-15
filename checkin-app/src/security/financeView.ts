/**
 * The finance view log at the boundary (docs/in-design/FINANCE_VIEW_RECORD_IDS.md).
 *
 * A GET response is a finance view when, after the stripper has run, it carries a
 * marked field on a top-level row that is not the viewer's own. Each such row names
 * its record as `Model:id`, with the marked field names it was sent, never their
 * values. A nested row's marked fields count toward the top-level row holding it.
 * Everything here reads the stripped bag, so the log names only what left the server.
 *
 * IMPORTANT: This file is CODEOWNERS-gated.
 */
import type { NextRequest } from 'next/server';
import type { AuthResult } from '@/types/auth';
import {
    recordFinanceViewCall,
    unionRecords,
    type FinanceViewRecord,
    type PageViewTag,
} from '@/lib/finance/financeViewLog';
import {
    HOUSEHOLD_OWNED_FINANCE_MODELS,
    getRoute,
    marks,
    modelRelations,
    parseIdPath,
    type FinanceViewModel,
    type FinanceViewRecordSpec,
    type FinanceViewSpec,
    type Role,
} from './core';
import { scopesHeld, type CallerContext } from './access-resolvers';
import { PAGE_VIEW_FOLDS, foldingPage } from './pageViewFolds';

type Row = Record<string, unknown>;

/** The browser's page-view id, minted per page load. */
export const PAGE_VIEW_ID_HEADER = 'x-page-view-id';
/** The page path the browser claims the call came from. */
export const PAGE_VIEW_PATH_HEADER = 'x-page-view-path';

const PAGE_VIEW_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PAGE_PATH = 512;

function isRow(value: unknown): value is Row {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rowsOf(value: unknown): Row[] {
    return (Array.isArray(value) ? value : [value]).filter(isRow);
}

/** A record id as text, or null when the value is not an id. */
export function idText(value: unknown): string | null {
    return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function memberOf(value: unknown, ids: ReadonlySet<number> | undefined): boolean {
    return typeof value === 'number' && ids !== undefined && ids.has(value);
}

/**
 * Whether a row is the viewer's own: their own record, or their household's. Decided
 * from the row's owner fields and the session, never from anything the browser sends.
 */
export function isOwnRow(model: string, row: Row, ctx: CallerContext): boolean {
    const scopes = scopesHeld(model, row, ctx);
    if (scopes.has('their_own') || scopes.has('their_households')) return true;
    if (!HOUSEHOLD_OWNED_FINANCE_MODELS.has(model)) return false;
    if (model === 'ProgramParticipant') return memberOf(row.personId, ctx.householdMemberIds);
    return (
        memberOf(row.subjectPersonId, ctx.householdMemberIds) ||
        (ctx.householdId !== undefined && row.requestedForHouseholdId === ctx.householdId)
    );
}

/** The marked fields a row carries, nested rows' prefixed by their relation path. */
function markedFields(model: string, value: unknown, prefix: string, out: Set<string>): void {
    for (const row of rowsOf(value)) {
        for (const field of marks[model] ?? []) {
            if (row[field] !== undefined) out.add(`${prefix}${field}`);
        }
        for (const [rel, info] of Object.entries(modelRelations(model))) {
            if (row[rel] !== undefined) markedFields(info.model, row[rel], `${prefix}${rel}.`, out);
        }
    }
}

function refFor(model: FinanceViewModel, holder: Row, id: string): string {
    if (typeof model === 'string') return `${model}:${id}`;
    const value = idText(holder[model.field]);
    const name = value === null ? undefined : model.map[value];
    return name ? `${name}:${id}` : `unknown-source:${value ?? ''}:${id}`;
}

function joinedId(holder: Row, fields: readonly string[]): string | null {
    const parts = fields.map(field => idText(holder[field]));
    return parts.every((p): p is string => p !== null) ? parts.join(':') : null;
}

function isParamId(id: FinanceViewRecordSpec['id']): id is { readonly param: string } {
    return typeof id === 'object' && !Array.isArray(id) && 'param' in id;
}

/**
 * The records one top-level row names. Undeclared, a row is its own model and `id`.
 * A record named from a nested list takes the marked fields inside its element; any
 * other record takes the whole row's. Marked fields no record could take are kept
 * under `unnamed:<key>`, so a view is never dropped for want of an id.
 */
export function rowRecords(
    key: string,
    row: Row,
    declarations: readonly FinanceViewRecordSpec[],
    params: Readonly<Record<string, string>>,
): FinanceViewRecord[] {
    const all = new Set<string>();
    markedFields(key, row, '', all);
    if (all.size === 0) return [];

    const out: FinanceViewRecord[] = [];
    const covered = new Set<string>();
    const add = (ref: string, fields: Iterable<string>) => {
        const list = [...fields];
        out.push({ ref, fields: list });
        for (const f of list) covered.add(f);
    };

    if (declarations.length === 0) {
        const id = idText(row.id);
        if (id !== null) add(`${key}:${id}`, all);
    }
    for (const declaration of declarations) {
        const { id, model } = declaration;
        if (isParamId(id)) {
            const value = idText(params[id.param]);
            if (value !== null) add(refFor(model, row, value), all);
            continue;
        }
        const parsed = (typeof id === 'string' ? [id] : id).map(parseIdPath);
        const list = parsed[0]?.list ?? null;
        const fields = parsed.map(p => p.field).filter((f): f is string => f !== null);
        if (list === null) {
            const value = joinedId(row, fields);
            if (value !== null) add(refFor(model, row, value), all);
            continue;
        }
        const items = row[list];
        if (!Array.isArray(items)) continue;
        const rel = modelRelations(key)[list];
        for (const item of items) {
            if (fields.length === 0) {
                const value = idText(item);
                if (value !== null) add(refFor(model, row, value), []);
                continue;
            }
            if (!isRow(item)) continue;
            const value = joinedId(item, fields);
            if (value === null) continue;
            const itemFields = new Set<string>();
            if (rel) markedFields(rel.model, item, `${list}.`, itemFields);
            add(refFor(model, item, value), itemFields);
        }
    }
    const left = [...all].filter(f => !covered.has(f));
    if (left.length > 0) out.push({ ref: `unnamed:${key}`, fields: left });
    return out;
}

/** Every record a stripped bag shows the viewer, other than their own. */
export function viewedRecords(
    bag: Readonly<Record<string, unknown>>,
    spec: FinanceViewSpec | undefined,
    ctx: CallerContext,
    params: Readonly<Record<string, string>>,
): FinanceViewRecord[] {
    const records: FinanceViewRecord[] = [];
    for (const [key, value] of Object.entries(bag)) {
        const declarations = (spec?.records ?? []).filter(r => r.key === key);
        for (const row of rowsOf(value)) {
            if (isOwnRow(key, row, ctx)) continue;
            records.push(...rowRecords(key, row, declarations, params));
        }
    }
    return unionRecords(records);
}

/** The served file's record, unless it is the viewer's own or its field is unmarked. */
export function fileRecords(
    model: string,
    field: string,
    row: Row,
    ctx: CallerContext,
    params: Readonly<Record<string, string>>,
): FinanceViewRecord[] {
    if (!(marks[model] ?? []).includes(field) || isOwnRow(model, row, ctx)) return [];
    const id = idText(row.id ?? params.id);
    return [{ ref: id === null ? `unnamed:${model}` : `${model}:${id}`, fields: [field] }];
}

/**
 * The call's page-view tag, or null when it has none or may not fold into its claimed
 * page. The writer enforces the other limits: one person, one path, thirty seconds.
 */
export function pageViewTag(req: Pick<NextRequest, 'headers'>, endpoint: string): PageViewTag | null {
    const id = req.headers.get(PAGE_VIEW_ID_HEADER);
    const path = req.headers.get(PAGE_VIEW_PATH_HEADER);
    if (id === null || path === null || !PAGE_VIEW_ID.test(id)) return null;
    if (path.length > MAX_PAGE_PATH || !path.startsWith('/') || path.startsWith('//') || /[?#\s]/.test(path)) return null;
    const page = foldingPage(path);
    if (page === null || !PAGE_VIEW_FOLDS[page].includes(endpoint)) return null;
    return { id, path };
}

/** The route's declared query parameters present on the call; any other parameter stays out. */
export function declaredQuery(url: URL, spec: FinanceViewSpec | undefined): Record<string, string> {
    const query: Record<string, string> = {};
    for (const name of spec?.query ?? []) {
        const value = url.searchParams.get(name);
        if (value !== null) query[name] = value;
    }
    return query;
}

/** Routes in the page allowlist that are not registered GET routes. */
export function pageViewFoldErrors(): string[] {
    return Object.entries(PAGE_VIEW_FOLDS).flatMap(([page, endpoints]) =>
        endpoints
            .filter(endpoint => !endpoint.startsWith('GET ') || getRoute(endpoint) === undefined)
            .map(endpoint => `${page}: '${endpoint}' is not a registered GET route`),
    );
}

/**
 * Write the finance-view call for these records. Returns false when it could not be
 * written; the caller then refuses the response.
 */
export async function recordView(args: {
    endpoint: string;
    req: NextRequest;
    auth: AuthResult;
    role: Role;
    records: FinanceViewRecord[];
    spec: FinanceViewSpec | undefined;
}): Promise<boolean> {
    const { endpoint, req, auth, role, records, spec } = args;
    if (auth.type !== 'session' || !Number.isInteger(auth.user.id)) {
        console.error(`[${endpoint}] finance view has no person to record`);
        return false;
    }
    const url = new URL(req.url);
    try {
        await recordFinanceViewCall({
            actorId: auth.user.id,
            role,
            endpoint,
            path: url.pathname,
            query: declaredQuery(url, spec),
            records,
            pageView: pageViewTag(req, endpoint),
        });
        return true;
    } catch (err) {
        console.error(`[${endpoint}] finance view not recorded:`, err);
        return false;
    }
}
