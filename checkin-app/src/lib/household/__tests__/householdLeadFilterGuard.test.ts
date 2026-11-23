/** @jest-environment node */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

/**
 * Ratchet: no hand-spelled household-lead read filter outside ALLOWLIST.
 *
 * A lead filter is an `isHouseholdLead: true` (or `{ equals: true }`) property whose nearest
 * enclosing key is a Prisma filter key, or that sits in a const typed `*WhereInput`. Under a
 * projection or write key, or in a `*Select` const, it is not a filter. Anywhere else the
 * scan cannot place it, so it counts. New filters use `householdLeadsWhere` from
 * `lib/household/leads.ts`.
 *
 * Exact counts both ways: a new copy fails, and so does an entry left behind after its
 * copies moved onto a helper.
 *
 * Scans `checkin-app/src`. Skips every `__tests__/`, `tests/`, `test-helpers/` and `generated/`
 * directory, every `*.test.ts(x)` file, `src/security/` (the boundary layer, which spells
 * lead scopes in its own grammar), and `lib/household/leads.ts` (the helper's home). The
 * prisma seed lives outside `src/`, so it is never scanned.
 *
 * ponytail: syntax only. A filter built from a variable holding `true`, or assembled by
 * a function the scan does not follow, is not seen.
 */

const SRC = join(__dirname, '../../..');

const FILTER_KEYS = new Set(['where', 'some', 'none', 'every', 'is', 'isNot', 'AND', 'OR', 'NOT']);

/** Keys whose object is a projection, a write, or an audit payload rather than a filter. */
const IGNORE_KEYS = new Set(['select', 'omit', 'data', 'create', 'update', 'newData', 'oldData', 'attempted']);

const SKIP_DIRS = new Set(['__tests__', 'tests', 'test-helpers', 'generated', 'node_modules']);
const SKIP_FILES = new Set([join('security'), join('lib', 'household', 'leads.ts')]);
const TEST_FILE = /\.test\.tsx?$/;

type Entry = { file: string; count: number; reason: string };

const HELPER = 'householdLeadsWhere fits';
const RELATION = 'relation-scoped; needs a sibling helper';
const ANY_LEAD = 'any lead, not by household; needs a sibling helper';

const ALLOWLIST: Entry[] = [
    { file: 'app/api/finance-ops/membership-payment-plans/route.ts', count: 1, reason: RELATION },
    { file: 'app/api/finance-ops/payment-plans/route.ts', count: 1, reason: RELATION },
    { file: 'app/api/finance-ops/payments/route.ts', count: 1, reason: RELATION },
    { file: 'app/api/membership-audit/compliance/route.ts', count: 2, reason: RELATION },
    { file: 'app/api/membership-audit/households-missing-contact/route.ts', count: 1, reason: RELATION },
    { file: 'app/api/membership-ops/volunteer-memberships/route.ts', count: 3, reason: `2 ${RELATION}; 1 ${ANY_LEAD}` },
    { file: 'app/api/membership/request-payment-plan/route.ts', count: 1, reason: RELATION },
    { file: 'app/api/membership/reviews/route.ts', count: 1, reason: RELATION },
    { file: 'app/api/programs/[id]/participants/route.ts', count: 1, reason: `${HELPER}; gates enrolment` },
    { file: 'app/api/programs/[id]/request-payment-plan/route.ts', count: 1, reason: `${HELPER}; gates the request` },
    { file: 'app/api/programs/[id]/route.ts', count: 1, reason: RELATION },
    { file: 'app/api/safety/trusted-adults/route.ts', count: 1, reason: RELATION },
    { file: 'lib/emailRecipients.ts', count: 2, reason: RELATION },
    { file: 'lib/finance/reconcile/membership.ts', count: 1, reason: ANY_LEAD },
    { file: 'lib/finance/reconcile/program.ts', count: 1, reason: ANY_LEAD },
    { file: 'lib/household/filters.ts', count: 3, reason: RELATION },
    { file: 'lib/membership/boardAlerts.ts', count: 1, reason: ANY_LEAD },
    { file: 'lib/outreach/recipients.ts', count: 1, reason: ANY_LEAD },
    { file: 'lib/programs/paymentVisibility.ts', count: 1, reason: `${ANY_LEAD}; gates payment visibility` },
    { file: 'lib/trusted-adult/service.ts', count: 1, reason: `${HELPER}; gates trusted-adult writes` },
];

type Context = 'filter' | 'ignored' | 'unknown';

const keyName = (name: ts.PropertyName): string =>
    ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText();

/** `true`, or `{ equals: true }`. */
function isTrueValue(value: ts.Expression): boolean {
    if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
    return ts.isObjectLiteralExpression(value) && value.properties.some((p) =>
        ts.isPropertyAssignment(p) && keyName(p.name) === 'equals' && p.initializer.kind === ts.SyntaxKind.TrueKeyword);
}

function typeContext(type: ts.TypeNode | undefined, name?: string): Context | null {
    const text = type?.getText() ?? '';
    if (/WhereInput\b/.test(text)) return 'filter';
    if (/Select\b/.test(text) || (name !== undefined && /(_SELECT|Select)$/.test(name))) return 'ignored';
    return null;
}

/** Where an `isHouseholdLead` property sits, judged by its nearest enclosing key or declaration. */
function contextOf(prop: ts.PropertyAssignment): Context {
    let node: ts.Node = prop.parent;
    for (;;) {
        const parent = node.parent;
        if (ts.isPropertyAssignment(parent)) {
            const key = keyName(parent.name);
            if (FILTER_KEYS.has(key)) return 'filter';
            if (IGNORE_KEYS.has(key)) return 'ignored';
            node = parent.parent;
        } else if (ts.isSatisfiesExpression(parent) || ts.isAsExpression(parent)) {
            const found = typeContext(parent.type);
            if (found) return found;
            node = parent;
        } else if (ts.isVariableDeclaration(parent)) {
            return typeContext(parent.type, ts.isIdentifier(parent.name) ? parent.name.text : undefined) ?? 'unknown';
        } else if (
            ts.isObjectLiteralExpression(parent) || ts.isArrayLiteralExpression(parent) || ts.isParenthesizedExpression(parent)
            || ts.isConditionalExpression(parent) || ts.isSpreadAssignment(parent)
        ) {
            node = parent;
        } else {
            return 'unknown';
        }
    }
}

/** Each lead filter in `source`, as `line: context`. */
function leadFilters(source: string, fileName = 'file.ts'): string[] {
    const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true,
        fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isPropertyAssignment(node) && keyName(node.name) === 'isHouseholdLead' && isTrueValue(node.initializer)) {
            const context = contextOf(node);
            if (context !== 'ignored') {
                const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
                found.push(`${line}: ${context}`);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return found;
}

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (SKIP_FILES.has(relative(SRC, path))) return [];
        if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(path);
        return /\.tsx?$/.test(entry.name) && !TEST_FILE.test(entry.name) ? [path] : [];
    });
}

describe('leadFilters', () => {
    it.each([
        ['prisma.person.findMany({ where: { householdId, isHouseholdLead: true } })', 'filter'],
        ['prisma.person.findFirst({ where: { id, householdId: h, isHouseholdLead: { equals: true } } })', 'filter'],
        ['select({ householdMembers: { where: { isHouseholdLead: true }, select: { id: true } } })', 'filter'],
        ['f({ householdMembers: { none: { isHouseholdLead: true } } })', 'filter'],
        ['f({ where: { OR: [{ subjectPerson: { householdId, isHouseholdLead: true } }] } })', 'filter'],
        ['f({ where: { ...(x ? { OR: [{ isHouseholdLead: true }] } : { isHouseholdLead: true }) } })', 'filter'],
        ['const where: Prisma.PersonWhereInput = { isHouseholdLead: true };', 'filter'],
        ['const leadsOnly = { isHouseholdLead: true };', 'unknown'],
        ['f({ isHouseholdLead: true })', 'unknown'],
    ])('flags %s', (source, context) => {
        expect(leadFilters(source).map((hit) => hit.split(': ')[1])).toContain(context);
    });

    it.each([
        ['prisma.person.findUnique({ where: { id }, select: { householdId: true, isHouseholdLead: true } })'],
        ['tx.person.update({ where: { id }, data: { isHouseholdLead: true } })'],
        ['audit({ newData: { ...lead, isHouseholdLead: true }, oldData: { ...(c ? { isHouseholdLead: true } : {}) } })'],
        ['const attempt = { table: "Person", attempted: { isHouseholdLead: true } };'],
        ['const LEAD_SELECT = { name: true, isHouseholdLead: true } as const;'],
        ['const PEER = { id: true, isHouseholdLead: true } satisfies Prisma.PersonSelect;'],
        ['prisma.person.findMany({ where: { isHouseholdLead: false } })'],
        ['// where: { isHouseholdLead: true }'],
    ])('ignores %s', (source) => {
        expect(leadFilters(source)).toEqual([]);
    });
});

describe('household-lead read filters', () => {
    it('appear only where ALLOWLIST says, at its exact counts', () => {
        const actual = new Map<string, string[]>();
        for (const path of sourceFiles(SRC)) {
            const source = readFileSync(path, 'utf8');
            if (!source.includes('isHouseholdLead')) continue;
            const hits = leadFilters(source, path);
            if (hits.length) actual.set(relative(SRC, path).split(sep).join('/'), hits);
        }
        const expected = new Map(ALLOWLIST.map((e) => [e.file, e.count]));
        const problems = [...new Set([...actual.keys(), ...expected.keys()])].sort().flatMap((file) => {
            const hits = actual.get(file) ?? [];
            const want = expected.get(file) ?? 0;
            if (hits.length === want) return [];
            if (hits.length > want) {
                return [`${file}: ${hits.length} lead filter(s), allowlisted ${want} (lines ${hits.join(', ')}). `
                    + 'Use householdLeadsWhere(householdId) from lib/household/leads.ts. '
                    + 'If the site is not a "leads of household X" read, classify it: a projection or write whose '
                    + 'key the scan does not know goes in IGNORE_KEYS; a different lead query is a sibling-helper case.'];
            }
            return [`${file}: ${hits.length} lead filter(s), allowlisted ${want}. Lower its ALLOWLIST count, or drop the entry at 0.`];
        });
        expect(problems).toEqual([]);
    });
});
