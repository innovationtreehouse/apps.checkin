import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { TRANSITIONS as PROCESS_TX } from '../../membership/lifecycle';

/**
 * Ratchet: no machine-column write outside the declared helpers, flag-only writes included.
 *
 * Scans src/ for every Prisma write that sets a machine column on ProgramParticipant,
 * OrgMembership or OrgMembershipProcess, or whose data the scan cannot read (a variable
 * or a spread), and fails on any (file, table) whose count isn't what ALLOWLIST says.
 *
 * Declared, so not counted:
 * - ProgramParticipant: a write taking both `where` and `data` from one ENROLLMENT_WRITES
 *   entry, named or picked into a const by a ternary, with no machine column written beside it.
 * - OrgMembership: `setHouseholdStatus`, its one status writer.
 * - OrgMembershipProcess: a status write that is a CAS on the table (`...fromWhere(<from>)`
 *   or a StateSet's `...x.where`), or a create landing on a ∅-entry state.
 *
 * Exact counts both ways: a new raw write fails, and so does a row left behind
 * after its writes moved onto a helper.
 *
 * ponytail: a regex scan, not a type-aware one — a spread beside a declared write is
 * not inspected. Upgrade to a ts-morph walk if that bites.
 */

const SRC = join(__dirname, '../../..'); // .../src

type Table = 'ProgramParticipant' | 'OrgMembership' | 'OrgMembershipProcess';
type Entry = { file: string; table: Table; count: number; reason: string };

const MACHINE_COLUMNS: Record<Table, readonly string[]> = {
    ProgramParticipant: ['status', 'inventoryHeldAt', 'isPaymentPlanRequested', 'paymentPlanDeniedAt'],
    OrgMembership: ['status'],
    OrgMembershipProcess: ['status', 'contractSignedAt', 'bgConsentAt', 'bgClearedAt', 'paidAt'],
};

/** Files that own status writes by design, or never run in prod. */
const EXEMPT = new Set([
    'lib/membership/householdStatus.ts', // the household-status writer itself
    'lib/dev/seed-helpers.ts', // dev seed macros
]);

const ALLOWLIST: Entry[] = [
    { file: 'app/api/membership/request-payment-plan/route.ts', table: 'OrgMembershipProcess', count: 1, reason: 'data spread; slice 2 declares it' },
    { file: 'app/api/programs/[id]/participants/route.ts', table: 'ProgramParticipant', count: 1, reason: 'T1/T2 create at the entry status' },
    { file: 'lib/lifecycleDrift.ts', table: 'ProgramParticipant', count: 1, reason: 'repairs an off-diagram ACTIVE row, which no guard admits' },
    { file: 'lib/membership/external.ts', table: 'OrgMembershipProcess', count: 1, reason: 'flag-only or unreadable write; slice 2 declares it' },
    { file: 'lib/membership/mergeBgAdvance.ts', table: 'OrgMembershipProcess', count: 1, reason: 'flag-only or unreadable write; slice 2 declares it' },
    { file: 'lib/membership/payment.ts', table: 'OrgMembershipProcess', count: 1, reason: 'flag-only or unreadable write; slice 2 declares it' },
];

const CALL = /\b(programParticipant|orgMembership|orgMembershipProcess)\.(update|updateMany|upsert|create|createMany)\s*\(/g;
const NESTED = /\b(programParticipants?|orgMembership|orgMembershipProcess|processes)\s*:\s*\{\s*(create|createMany|upsert|update|updateMany|connectOrCreate)\s*:/g;
const RAW = /UPDATE\s+"(ProgramParticipant|OrgMembership|OrgMembershipProcess)"/g;

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

const setsColumn = (args: string, columns: readonly string[]) =>
    new RegExp(`\\b(${columns.join('|')})\\b\\s*[:,}]`).test(writePart(args));

/** Data the scan cannot read: `data: x`, shorthand `data`, or a spread. */
const opaqueData = (args: string) => {
    const write = writePart(args);
    return /\.\.\./.test(write) || /\b(data|create|update)\s*(?:[,}]|:\s*[^\s{])/.test(write);
};

const touchesMachine = (args: string, table: Table) => setsColumn(args, MACHINE_COLUMNS[table]) || opaqueData(args);

/** Both halves from one ENROLLMENT_WRITES entry, and no machine column written beside it. */
function declaredEnrollmentWrite(args: string, src = ''): boolean {
    if (setsColumn(args, MACHINE_COLUMNS.ProgramParticipant)) return false;
    const name = /ENROLLMENT_WRITES\.(\w+)\.where\b/.exec(args)?.[1];
    if (name !== undefined) return args.includes(`ENROLLMENT_WRITES.${name}.data(`);
    const picked = /\.\.\.(\w+)\.where\b/.exec(args)?.[1];
    return picked !== undefined && args.includes(`...${picked}.data(`) && new RegExp(`const ${picked} = [^;?]+\\? ENROLLMENT_WRITES\\.\\w+ : ENROLLMENT_WRITES\\.\\w+;`).test(src);
}

/** Statuses an OrgMembershipProcess may be created at: the ∅-edges' targets. */
const PROCESS_ENTRY = new Set<string>(PROCESS_TX.filter((t) => t.from === '∅').map((t) => t.to));

/** A process write the table already declares: a fromWhere CAS, or a create onto an entry state. */
function declaredProcessWrite(method: string, args: string): boolean {
    if (!setsColumn(args, ['status'])) return false;
    if (/\bfromWhere\(|\.\.\.\s*\w+\.where\b/.test(args)) return true;
    const status = /\bstatus\s*:\s*["'](\w+)["']/.exec(writePart(args))?.[1];
    return method === 'create' && status !== undefined && PROCESS_ENTRY.has(status);
}
const tableOf = (name: string): Table =>
    name.startsWith('programParticipant') ? 'ProgramParticipant' : name === 'orgMembership' ? 'OrgMembership' : 'OrgMembershipProcess';

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
            const args = block(src, m.index! + m[0].length - 1);
            const table = tableOf(m[1]);
            if (table === 'ProgramParticipant' && declaredEnrollmentWrite(args, src)) continue;
            if (table === 'OrgMembershipProcess' && declaredProcessWrite(m[2], args)) continue;
            if (touchesMachine(args, table)) bump(file, table);
        }
        for (const m of src.matchAll(NESTED)) {
            const open = src.indexOf('{', m.index! + m[0].length);
            if (open !== -1 && setsColumn(block(src, open), MACHINE_COLUMNS[tableOf(m[1])])) bump(file, tableOf(m[1]));
        }
        for (const m of src.matchAll(RAW)) bump(file, m[1] as Table);
    }
    return counts;
}

describe('no raw machine-column writes', () => {
    it('every machine-column write is in a declared helper or on the allowlist, at its exact count', () => {
        const found = Object.fromEntries([...scan()].sort());
        const allowed = Object.fromEntries(ALLOWLIST.map((e) => [`${e.file}|${e.table}`, e.count]).sort());
        expect(found).toEqual(allowed);
    });

    it('the scanner sees a status write and ignores a status read', () => {
        const status = ['status'];
        expect(setsColumn(`{ where: { id, status: "ACTIVE" }, data: { status: "REVOKED" } }`, status)).toBe(true);
        expect(setsColumn(`{ where: { id, status: "ACTIVE" }, data: { isVolunteerFamily: true } }`, status)).toBe(false);
        expect(setsColumn(`{ where: { householdId }, create: { householdId }, update: {}, select: { id: true, status: true } }`, status)).toBe(false);
        expect(setsColumn(`{ data: { paidAt: now, ...payMeta, status: activating ? "ACTIVE" : "X" } }`, status)).toBe(true);
        expect(setsColumn(`{ data: { status } }`, status)).toBe(true);
        expect(declaredProcessWrite('updateMany', `{ where: { id, ...fromWhere("INTAKE") }, data: { status: "X" } }`)).toBe(true);
        expect(declaredProcessWrite('updateMany', `{ where: { id, ...awaitingBgReview.where }, data: { status: "X" } }`)).toBe(true);
        expect(declaredProcessWrite('create', `{ data: { kind: "INITIAL", status: "INTAKE" } }`)).toBe(true);
        expect(declaredProcessWrite('create', `{ data: { kind: "INITIAL", status: "ACTIVE" } }`)).toBe(false);
        expect(declaredProcessWrite('update', `{ where: { id }, data: { status: "BLOCKED" } }`)).toBe(false);
        expect(declaredProcessWrite('updateMany', `{ where: { id, ...fromWhere("INTAKE") }, data: { paidAt: now } }`)).toBe(false);
    });

    it('the scanner counts a flag-only write and data it cannot read', () => {
        const flagOnly = `{ where: { programId, isPaymentPlanRequested: true }, data: { isPaymentPlanRequested: false, paymentPlanDeniedAt: now } }`;
        expect(touchesMachine(flagOnly, 'ProgramParticipant')).toBe(true);
        expect(declaredEnrollmentWrite(flagOnly)).toBe(false);
        expect(touchesMachine(`{ where: { id }, data }`, 'ProgramParticipant')).toBe(true);
        expect(touchesMachine(`{ where: { id }, data: heldData }`, 'ProgramParticipant')).toBe(true);
        expect(touchesMachine(`{ where: { id }, data: { ...x } }`, 'ProgramParticipant')).toBe(true);
        expect(touchesMachine(`{ where: { id }, data: { personId: keepId } }`, 'ProgramParticipant')).toBe(false);
    });

    it('a declared enrollment write takes both halves from one entry and writes no machine column beside it', () => {
        const declared = (data: string) => declaredEnrollmentWrite(`{ where: { programId, ...ENROLLMENT_WRITES.denyHeld.where }, data: ${data} }`);
        expect(declared(`ENROLLMENT_WRITES.denyHeld.data(now)`)).toBe(true);
        expect(declared(`{ ...ENROLLMENT_WRITES.denyHeld.data(now), pendingSince: null }`)).toBe(true);
        expect(declared(`ENROLLMENT_WRITES.takeHold.data(now)`)).toBe(false);
        expect(declared(`{ ...ENROLLMENT_WRITES.denyHeld.data(now), status: "ACTIVE" }`)).toBe(false);
    });

    it('a picked enrollment write takes both halves from the const a ternary picks between entries', () => {
        const pick = `const w = comp ? ENROLLMENT_WRITES.reenrollComp : ENROLLMENT_WRITES.reenrollPaid;`;
        const write = `{ where: { id, ...w.where }, data: { ...w.data(), endedAt: null } }`;
        expect(declaredEnrollmentWrite(write, pick)).toBe(true);
        expect(declaredEnrollmentWrite(write, `const w = comp ? ENROLLMENT_WRITES.reenrollComp : rawWrite;`)).toBe(false);
        expect(declaredEnrollmentWrite(write)).toBe(false);
        expect(declaredEnrollmentWrite(`{ where: { id, ...w.where }, data: { ...x.data() } }`, pick)).toBe(false);
        expect(declaredEnrollmentWrite(`{ where: { id, ...w.where }, data: { ...w.data(), status: "ACTIVE" } }`, pick)).toBe(false);
    });

    it('the household-status helper is the one OrgMembership status writer it claims to be', () => {
        const src = readFileSync(join(SRC, 'lib/membership/householdStatus.ts'), 'utf8');
        const writes = [...src.matchAll(CALL)].filter((m) => m[1] === 'orgMembership' && setsColumn(block(src, m.index! + m[0].length - 1), ['status']));
        expect(writes).toHaveLength(1);
    });
});
