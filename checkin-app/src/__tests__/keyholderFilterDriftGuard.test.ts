import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Keyholder-filter drift guard (lib/visit/filters.ts): every query that asks
 * "is a keyholder in the building" or "who is a keyholder" uses LIVE_KEYHOLDER
 * or KEYHOLDER_IN_BUILDING, so a merged-away keyholder counts nowhere or
 * everywhere, never in one place and not another.
 *
 * A site is any `isKeyholder: true` in src/app + src/lib. It passes when the
 * object it sits in is a `select` (reading the flag) or a write (`data`,
 * `create`, `update`); anything else is a filter and must use the shared one.
 */

const SRC = join(__dirname, '..');
const HOME = 'lib/visit/filters.ts';
const ALLOWED_KEYS = new Set(['select', 'data', 'create', 'update']);
const SITE_RE = /\bisKeyholder\s*:\s*true\b/g;

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

/** Comment bodies blanked to spaces, same length, so a mention in a comment is no site. */
function maskComments(s: string): string {
    return s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, m => m.replace(/[^\n]/g, ' '));
}

/** The key of the object literal enclosing `pos`, e.g. `select` or `person`. */
function enclosingKey(s: string, pos: number): string | null {
    let depth = 0;
    for (let i = pos; i >= 0; i--) {
        if (s[i] === '}') depth++;
        else if (s[i] === '{') {
            if (depth === 0) return /(\w+)\s*:\s*$/.exec(s.slice(Math.max(0, i - 80), i))?.[1] ?? null;
            depth--;
        }
    }
    return null;
}

function keyholderFilterSites(src: string): number[] {
    const s = maskComments(src);
    const lines: number[] = [];
    for (const m of s.matchAll(SITE_RE)) {
        const key = enclosingKey(s, m.index!);
        if (!key || !ALLOWED_KEYS.has(key)) lines.push(s.slice(0, m.index!).split('\n').length);
    }
    return lines;
}

describe('keyholder filter drift guard', () => {
    it('flags a hand-rolled keyholder filter and passes a select or a write', () => {
        expect(keyholderFilterSites('db.visit.count({ where: { departedAt: null, person: { isKeyholder: true } } })')).toEqual([1]);
        expect(keyholderFilterSites('db.person.findMany({ where: { ...LIVE_PERSON, isKeyholder: true } })')).toEqual([1]);
        expect(keyholderFilterSites('db.person.findMany({ select: { id: true, isKeyholder: true } })')).toEqual([]);
        expect(keyholderFilterSites('db.person.update({ where: { id }, data: { isKeyholder: true } })')).toEqual([]);
        expect(keyholderFilterSites('// person: { isKeyholder: true }')).toEqual([]);
    });

    it('every keyholder filter in src/app and src/lib uses LIVE_KEYHOLDER or KEYHOLDER_IN_BUILDING', () => {
        const offenders: string[] = [];
        for (const file of [...walk(join(SRC, 'app')), ...walk(join(SRC, 'lib'))]) {
            const rel = relative(SRC, file).split(sep).join('/');
            if (rel === HOME) continue;
            for (const line of keyholderFilterSites(readFileSync(file, 'utf8'))) offenders.push(`${rel}:${line}`);
        }
        expect(offenders).toEqual([]);
    });
});
