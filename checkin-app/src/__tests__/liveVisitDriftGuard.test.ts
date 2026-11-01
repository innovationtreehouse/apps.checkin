import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * LIVE_VISIT drift guard (lib/visit/filters.ts): a source scanner over every
 * Visit query.
 *
 * A deleted Visit is a TOMBSTONE, not a removed row: `deletedAt` gets set and
 * the row survives (reviewable, reversible). Any code that lists, counts, or
 * aggregates visits without routing through LIVE_VISIT silently resurrects
 * deleted visits — into the live-attendance roster, derived hours, the
 * one-open-visit guards — the day someone deletes one. This test greps every
 * Visit-query site in src/app + src/lib and asserts each one references
 * LIVE_VISIT / deletedAt in its own query context, or is named in the
 * ALLOWLIST with a reviewed justification.
 *
 * Unlike merge tombstones (which hold real resources a sweep must release),
 * a deleted visit holds nothing — so sweeps and reconcilers filter too, and
 * this ALLOWLIST is expected to stay near-empty. `findUnique`/`findUniqueOrThrow`
 * are excluded for the same boundary reason as the Person guard: a one-row
 * fetch by unique key can't leak a tombstone into a list or a count — but the
 * caller owns rejecting a tombstoned row where it matters (the route
 * pre-checks do this explicitly).
 */

const SRC = join(__dirname, '..');

const ALLOWLIST: Record<string, string> = {
    'app/api/facility/trends/route.ts': 'Scanner is textually blind to the variable-held where: the findMany passes `whereClause`, which is built a few lines up WITH `deletedAt: null`.',
    'app/api/membership-ops/participants/merge/analyze/route.ts': 'Merge PREVIEW: `_count.visits` counts the rows the merge will move, and a merge moves tombstoned visits with the person (provenance travels). Filtering would understate the preview against the actual move.',
    'lib/person/merge/execute.ts': 'The merge itself: tombstoned visits travel with the person, same rule the PREVIEW counts by — filtering would strand them on the merged-away tombstone.',
    'lib/programs/events.ts': 'Event cancel nulls `associatedEventId` on every visit pointing at the doomed event, tombstoned included — the FK must clear or the event delete fails, and the tombstone keeps its own times either way.',
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

/** Capture the object literal at/after `from`, skipping strings & comments. */
function captureObject(s: string, from: number): { text: string; end: number } | null {
    let i = s.indexOf('{', from);
    if (i < 0) return null;
    const start = i;
    let depth = 0;
    for (; i < s.length; i++) {
        const c = s[i];
        const d = s[i + 1];
        if (c === '/' && d === '/') {
            i = s.indexOf('\n', i);
            if (i < 0) i = s.length;
            continue;
        }
        if (c === '/' && d === '*') {
            i = s.indexOf('*/', i + 2);
            i = i < 0 ? s.length : i + 1;
            continue;
        }
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
            if (depth === 0) return { text: s.slice(start, i + 1), end: i + 1 };
        }
    }
    return null;
}

// A direct list/count/bulk-write call on the Visit delegate. A bulk write is in
// scope for the same reason a read is: an unpredicated `updateMany`/`deleteMany`
// rewrites or removes tombstoned rows. findUnique(OrThrow) and single-row
// update/delete are deliberately absent — see the boundary note in the header.
const VISIT_CALL_RE = /\b(?:prisma|tx|db)\.visit\.(findMany|findFirst|count|aggregate|groupBy|updateMany|deleteMany)\s*\(/g;

// A nested pull of Visit rows through another model's query — `visits: true`
// or `visits: { ... }`. Unlike the Person guard's relation class, ANY nested
// visits pull is a list (the relation is one-to-many), so there is no
// pure-filter shape to exempt: it must carry the filter in its own config.
const VISITS_RELATION_RE = /\bvisits\s*:\s*(true|\{)/g;

// KEYHOLDER_IN_BUILDING (lib/visit/filters.ts) spreads LIVE_VISIT.
const FILTERED_RE = /LIVE_VISIT|deletedAt|KEYHOLDER_IN_BUILDING/;

function scan(): Set<string> {
    const hits = new Set<string>();
    for (const file of walk(SRC)) {
        const src = readFileSync(file, 'utf8');
        const rel = relative(SRC, file).split(sep).join('/');

        VISIT_CALL_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = VISIT_CALL_RE.exec(src))) {
            const parenIndex = m.index + m[0].length - 1; // the call's own '('
            const args = captureObject(src, parenIndex);
            const scopeText = args ? args.text : src.slice(m.index, m.index + 200);
            if (!FILTERED_RE.test(scopeText)) hits.add(rel);
        }

        VISITS_RELATION_RE.lastIndex = 0;
        while ((m = VISITS_RELATION_RE.exec(src))) {
            if (m[1] === 'true') { hits.add(rel); continue; }
            const obj = captureObject(src, m.index);
            if (!obj) continue;
            // Query-shaped configs only — a `visits: { id: number }[]` TYPE
            // literal carries none of these keys and is not a data pull.
            if (!/\b(?:where|select|include|orderBy|take)\s*:/.test(obj.text)) continue;
            if (!FILTERED_RE.test(obj.text)) hits.add(rel);
        }
    }
    return hits;
}

describe('LIVE_VISIT drift guard', () => {
    const flagged = [...scan()];
    const known = new Set(Object.keys(ALLOWLIST));

    it('no unfiltered Visit-query site outside the ALLOWLIST', () => {
        const unexpected = flagged.filter((f) => !known.has(f)).sort();
        // A new one of these must either spread LIVE_VISIT into its where, or be
        // added to ALLOWLIST above with a reviewed justification.
        expect(unexpected).toEqual([]);
    });

    it('has no stale allowlist entry (a listed file no longer has an unfiltered site)', () => {
        const live = new Set(flagged);
        const stale = [...known].filter((f) => !live.has(f)).sort();
        expect(stale).toEqual([]);
    });
});
