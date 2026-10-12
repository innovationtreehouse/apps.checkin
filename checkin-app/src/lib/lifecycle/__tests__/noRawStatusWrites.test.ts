import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Ratchet: no status write outside the declared helpers.
 *
 * Scans src/ for every Prisma write that sets `status` on OrgMembership (household
 * status) or OrgMembershipProcess (application status), and fails on any (file,
 * table) whose count isn't exactly what ALLOWLIST says. OrgMembership.status has
 * one writer, `setHouseholdStatus`; every other site listed below is a known
 * offender waiting for the chip named beside it, which removes its row.
 *
 * Exact counts both ways: a new raw write fails, and so does a row left behind
 * after its writes moved onto a helper.
 *
 * ponytail: a regex scan, not a type-aware one — a `data` object built in a
 * variable elsewhere is invisible to it. Upgrade to a ts-morph walk if that bites.
 */

const SRC = join(__dirname, '../../..'); // .../src

type Table = 'OrgMembership' | 'OrgMembershipProcess';
type Entry = { file: string; table: Table; count: number; chip: string };

/** Files that own status writes by design, or never run in prod. */
const EXEMPT = new Set([
    'lib/membership/householdStatus.ts', // the household-status writer itself
    'lib/dev/seed-helpers.ts', // dev seed macros
]);

const ALLOWLIST: Entry[] = [];

const CALL = /\b(orgMembership|orgMembershipProcess)\.(update|updateMany|upsert|create|createMany)\s*\(/g;
const NESTED = /\b(orgMembership|orgMembershipProcess|processes)\s*:\s*\{\s*(create|createMany|upsert|update|updateMany|connectOrCreate)\s*:/g;
const RAW = /UPDATE\s+"(OrgMembership|OrgMembershipProcess)"/g;

/** The balanced `(...)`/`{...}` block opening at `open`, exclusive of the delimiters. */
function block(src: string, open: number): string {
    const pair: Record<string, string> = { '(': ')', '{': '}' };
    const close = pair[src[open]];
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === src[open]) depth++;
        else if (src[i] === close && --depth === 0) return src.slice(open + 1, i);
    }
    return src.slice(open + 1);
}

/** Drop the read-only clauses so `status` inside them doesn't count as a write. */
function writePart(args: string): string {
    let out = args;
    for (const key of ['where', 'select', 'include']) {
        const re = new RegExp(`\\b${key}\\s*:\\s*\\{`);
        let m: RegExpExecArray | null;
        while ((m = re.exec(out))) {
            const open = m.index + m[0].length - 1;
            out = out.slice(0, m.index) + out.slice(open + block(out, open).length + 2);
        }
    }
    return out;
}

const setsStatus = (args: string) => /\bstatus\b\s*[:,}]/.test(writePart(args));
const tableOf = (name: string): Table => (name === 'orgMembership' ? 'OrgMembership' : 'OrgMembershipProcess');

function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) return name === '__tests__' || name === 'generated' ? [] : files(p);
        return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
    });
}

function scan(): Map<string, number> {
    const counts = new Map<string, number>();
    const bump = (file: string, table: Table) => counts.set(`${file}|${table}`, (counts.get(`${file}|${table}`) ?? 0) + 1);
    for (const path of files(SRC)) {
        const file = relative(SRC, path);
        if (EXEMPT.has(file)) continue;
        const src = readFileSync(path, 'utf8');
        for (const m of src.matchAll(CALL)) {
            if (setsStatus(block(src, m.index! + m[0].length - 1))) bump(file, tableOf(m[1]));
        }
        for (const m of src.matchAll(NESTED)) {
            const open = src.indexOf('{', m.index! + m[0].length);
            if (open !== -1 && setsStatus(block(src, open))) bump(file, m[1] === 'orgMembership' ? 'OrgMembership' : 'OrgMembershipProcess');
        }
        for (const m of src.matchAll(RAW)) bump(file, m[1] as Table);
    }
    return counts;
}

describe('no raw OrgMembership / OrgMembershipProcess status writes', () => {
    it('every status write is in a declared helper or on the allowlist, at its exact count', () => {
        const found = Object.fromEntries([...scan()].sort());
        const allowed = Object.fromEntries(ALLOWLIST.map((e) => [`${e.file}|${e.table}`, e.count]).sort());
        expect(found).toEqual(allowed);
    });

    it('the scanner sees a status write and ignores a status read', () => {
        expect(setsStatus(`{ where: { id, status: "ACTIVE" }, data: { status: "REVOKED" } }`)).toBe(true);
        expect(setsStatus(`{ where: { id, status: "ACTIVE" }, data: { isVolunteer: true } }`)).toBe(false);
        expect(setsStatus(`{ where: { householdId }, create: { householdId }, update: {}, select: { id: true, status: true } }`)).toBe(false);
        expect(setsStatus(`{ data: { paidAt: now, ...payMeta, status: activating ? "ACTIVE" : "X" } }`)).toBe(true);
        expect(setsStatus(`{ data: { status } }`)).toBe(true);
    });

    it('the household-status helper is the one OrgMembership status writer it claims to be', () => {
        const src = readFileSync(join(SRC, 'lib/membership/householdStatus.ts'), 'utf8');
        const writes = [...src.matchAll(CALL)].filter((m) => m[1] === 'orgMembership' && setsStatus(block(src, m.index! + m[0].length - 1)));
        expect(writes).toHaveLength(1);
    });
});
