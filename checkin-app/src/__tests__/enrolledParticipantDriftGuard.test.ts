import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * ENROLLED_PARTICIPANT drift guard (lib/person/filters.ts), the enrollment-status
 * sibling of livePersonDriftGuard.test.ts.
 *
 * A WITHDRAWN ProgramParticipant row stays in the table as history. A read that
 * filters by nothing but programId/personId counts that row as an enrollment:
 * the person stays on rosters, capacity counts, compliance lists, and their scan
 * still resolves to the program's events. This test finds every ProgramParticipant
 * read in src/app + src/lib and requires each one to either filter on status in
 * its own query (ENROLLED_PARTICIPANT, a status literal, or an enrollmentState
 * STATES/fromWhere definition), or be named in ALLOWLIST with a reviewed reason.
 *
 * What counts as a site:
 *   1. A list/count call on the delegate:
 *        prisma|tx|db.programParticipant.findMany|findFirst|count|aggregate|groupBy(...)
 *      findUnique and the single-row writes take the composite key of one known
 *      row, the same boundary livePersonDriftGuard draws.
 *   2. A nested read through a ProgramParticipant relation (Person.programParticipants,
 *      Program.participants): `<rel>: true`, or `<rel>: { ... }` whose body selects,
 *      includes, filters (`where:`) or quantifies (`some:`/`every:`/`none:`). An
 *      object without any of those is not a Prisma relation config (a TS type, a
 *      response field) and is skipped.
 *
 * A `status: true` select is not a filter; only a status condition counts.
 *
 * Two assertions: no unlisted unfiltered site, and no stale allowlist entry.
 */

const SRC = join(__dirname, '..');
const ROOTS = ['app', 'lib'].map((d) => join(SRC, d));

/**
 * Files whose ProgramParticipant reads deliberately include WITHDRAWN rows.
 * Rule: a read that decides who is enrolled now filters; a read that settles
 * money, audits history, or targets one row by its order or key does not.
 */
const ALLOWLIST: Record<string, string> = {
    // ── money: an order or refund must still find the row it paid for ─────────
    'lib/finance/reconcile/program.ts': 'Payment reconciler: matches Shopify orders to enrollment rows by order id. A withdrawn row keeps its shopifyOrderId, and a late order or refund must still land on it rather than read as unmatched.',
    'lib/finance/reconcile/reversals.ts': 'Refund/chargeback reconciler: matches by shopifyOrderId. A late refund on a withdrawn row must attach to it (design §5). The delete path\'s status guard lands with the withdraw write path.',
    'lib/finance/matchAudit.ts': 'Order-match audit: a historical report over which orders claimed which enrollments. A withdrawn row still claimed its order.',
    'app/api/finance-ops/s-read/match-audit/track/route.ts': 'Order-claim check: "has any enrollment claimed this order". A withdrawn row still holds its order; filtering it would report the order unmatched.',

    // ── sweeps that must see every row ────────────────────────────────────────
    'lib/lifecycleDrift.ts': 'Invariant scanner and auto-heal over every enrollment row. It must see a WITHDRAWN row to check the invariants on it.',

    // ── history and identity tooling ──────────────────────────────────────────
    'lib/person/merge/plan.ts': 'Person merge plan: moves every enrollment row, withdrawn ones included, so history follows the surviving person.',
    'app/api/membership-ops/participants/merge/analyze/route.ts': 'Person merge analysis: shows every enrollment row the merge will move, withdrawn ones included.',
    'lib/programs/events.ts': 'Attendance-correction IDOR guard pinned to one target: a correction to a past session must still be allowed for someone who was enrolled then and has since withdrawn.',
    'app/api/programs/[id]/eligible-participants/route.ts': 'Excludes anyone with a row for this program, withdrawn included, because enrolling them would collide with the composite key. Letting WITHDRAWN back in ships with the re-enrol upsert.',

    // ── dev-only tooling ──────────────────────────────────────────────────────
    'app/api/dev/shopify/orders-paid/route.ts': 'Dev-only mock-webhook firer (isDevInstance gated). Reads the rows named in the request body. No production effect.',
};

function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
            if (!['node_modules', 'generated', '__tests__'].includes(e.name)) walk(full, out);
        } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
            out.push(full);
        }
    }
    return out;
}

/** `src` with comments blanked to spaces, same length, so indexes still line up. */
function maskComments(s: string): string {
    const out = s.split('');
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        const d = s[i + 1];
        if (c === '/' && d === '/') {
            while (i < s.length && s[i] !== '\n') out[i++] = ' ';
        } else if (c === '/' && d === '*') {
            const end = s.indexOf('*/', i + 2);
            const stop = end < 0 ? s.length : end + 2;
            while (i < stop) {
                if (s[i] !== '\n') out[i] = ' ';
                i++;
            }
        } else if (c === "'" || c === '"' || c === '`') {
            i++;
            while (i < s.length && s[i] !== c) {
                if (s[i] === '\\') i++;
                i++;
            }
        }
    }
    return out.join('');
}

/** The object literal at/after `from`, skipping strings so a quoted brace can't unbalance it. */
function captureObject(s: string, from: number): string | null {
    let i = s.indexOf('{', from);
    if (i < 0) return null;
    const start = i;
    let depth = 0;
    for (; i < s.length; i++) {
        const c = s[i];
        if (c === "'" || c === '"' || c === '`') {
            const q = c;
            i++;
            while (i < s.length && s[i] !== q) {
                if (s[i] === '\\') i++;
                i++;
            }
            continue;
        }
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return s.slice(start, i + 1);
        }
    }
    return null;
}

const CALL_RE = /\b(?:prisma|tx|db)\.programParticipant\.(?:findMany|findFirst|count|aggregate|groupBy)\s*\(/g;
const RELATION_RE = /\b(?:programParticipants|participants)\s*:\s*(true|\{)/g;
const RELATION_CONFIG_RE = /\b(?:select|include|where|some|every|none)\s*:/;
const FILTERED_RE = /ENROLLED_PARTICIPANT|\bstatus\s*:(?!\s*true\b)|fromWhere|STATES\b/;

function scan(): Set<string> {
    const hits = new Set<string>();
    for (const file of ROOTS.flatMap((r) => walk(r))) {
        const src = maskComments(readFileSync(file, 'utf8'));
        const rel = relative(SRC, file).split(sep).join('/');
        let m: RegExpExecArray | null;

        CALL_RE.lastIndex = 0;
        while ((m = CALL_RE.exec(src))) {
            const args = captureObject(src, m.index + m[0].length - 1);
            if (!args || !FILTERED_RE.test(args)) hits.add(rel);
        }

        RELATION_RE.lastIndex = 0;
        while ((m = RELATION_RE.exec(src))) {
            if (m[1] === 'true') {
                hits.add(rel);
                continue;
            }
            const obj = captureObject(src, m.index);
            if (!obj || !RELATION_CONFIG_RE.test(obj)) continue;
            if (!FILTERED_RE.test(obj)) hits.add(rel);
        }
    }
    return hits;
}

describe('ENROLLED_PARTICIPANT drift guard', () => {
    const flagged = [...scan()];
    const known = new Set(Object.keys(ALLOWLIST));

    it('no unfiltered ProgramParticipant read outside the ALLOWLIST', () => {
        // A new one must filter on status (spread ENROLLED_PARTICIPANT), or be
        // added to ALLOWLIST with a reviewed reason.
        expect(flagged.filter((f) => !known.has(f)).sort()).toEqual([]);
    });

    it('has no stale allowlist entry', () => {
        const live = new Set(flagged);
        expect([...known].filter((f) => !live.has(f)).sort()).toEqual([]);
    });
});
