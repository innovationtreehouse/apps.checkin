/**
 * The whole-entity decommission certifier must accept exactly one shape —
 * entire top-level entries spliced out, subjects gone in the same PR — and
 * reject every partial edit, because partial removals can WIDEN exposure
 * (deleting one element of an `all:` match weakens the condition).
 */
import {
    BINDINGS_CONTAINERS,
    certifyDecommission,
    diffSegmentations,
    normalizeEntry,
    segmentByContainers,
    segmentTopLevelCalls,
} from '../lib/boundary-decommission';
import { parseArgs, main } from '../check-boundary-decommission';

const BINDINGS_BASE = `/**
 * SCOPE_BINDINGS — the declarative per-row scope table.
 */
import { makeScopesHeld, type ScopeBindings } from './scopes';

export const SCOPE_BINDINGS = {
    Person: {
        their_own: { field: 'id', eqCtx: 'selfId' },
        // note with braces: earns { field: 'personId' } later
        keyholders: { flag: 'isKeyholder' },
    },
    FeePayment: {
        their_own: { field: 'personId', eqCtx: 'selfId' },
        their_program_participants: { field: 'personId', inCtx: 'participantIdsInScopePrograms' },
    },
    Visit: {
        their_own: { field: 'personId', eqCtx: 'selfId' },
        all_current_visitors: {
            all: [{ flag: 'isKeyholder' }, { field: 'departedAt', isNull: true }],
        },
    },
    RawBadgeLog: { their_own: { field: 'personId', eqCtx: 'selfId' } },
} as const satisfies ScopeBindings;

export const ROW_SCOPE_KEY: Record<string, string> = {
    EmergencyContact: 'householdId',
};

export const OPT_OUT_PENDING_ROUTE = new Set<string>([
    'Corporation', // has leads→personId; a corp-lead view is plausible
    'PersonRole',
]);

export const scopesHeld = makeScopesHeld(SCOPE_BINDINGS, ROW_SCOPE_KEY);
`;

const REGISTRY_BASE = `/**
 * THE security policy.
 */
import { defineRoute, defineOutbound } from './core';

// ─── Routes ────────────────────────────────────────────────────────────────

defineRoute({
    endpoint: 'GET /api/profile',
    authorize: 'self',
    envelope: 'profile',
    returns: ['Person'],
    orderedView: [
        ['authenticated', ['their_own:pii', 'member', 'public']],
    ],
});

// Payments history for the caller's own household.
defineRoute({
    endpoint: 'GET /api/fees/payments',
    authorize: 'authenticated',
    envelope: null,
    returns: ['FeePayment'],
    orderedView: [
        ['authenticated', ['their_own:personal', 'member', 'public']],
    ],
});

defineOutbound({
    surface: 'email.admin-notify',
    tiers: ['public', 'pii'],
});
`;

const SCHEMA_BASE = `model Person {
  id Int @id
}

model FeePayment {
  id Int @id
  personId Int
}
`;

const SCHEMA_DROPPED = `model Person {
  id Int @id
}
`;

// Splice one or more whole line-ranges (inclusive, 0-indexed) out of a source.
const dropLines = (src: string, ...ranges: [number, number][]) =>
    src
        .split('\n')
        .filter((_, i) => !ranges.some(([a, b]) => i >= a && i <= b))
        .join('\n');

const lineOf = (src: string, needle: string) => src.split('\n').findIndex(l => l.includes(needle));

// Whole-entry removal of FeePayment from the bindings fixture.
const bindingsWithoutFeePayment = dropLines(
    BINDINGS_BASE,
    [lineOf(BINDINGS_BASE, 'FeePayment: {'), lineOf(BINDINGS_BASE, 'FeePayment: {') + 3],
);

describe('parseArgs', () => {
    // The shell → argv → lib wire is now the sole carrier of the boundary set;
    // pin its slicing so a workflow invocation-line edit can't silently drift.
    it('splits --base / --head / --boundary / -- into the certifier inputs', () => {
        expect(parseArgs(['--base', 'X', '--head', 'Y', '--boundary', 'a', 'b', '--', 'v'])).toEqual({
            baseSha: 'X',
            headSha: 'Y',
            boundaryChanged: ['a', 'b'],
            violations: ['v'],
        });
    });

    it('yields an empty boundary set when --boundary is omitted', () => {
        expect(parseArgs(['--base', 'X', '--head', 'Y', '--', 'v'])).toEqual({
            baseSha: 'X',
            headSha: 'Y',
            boundaryChanged: [],
            violations: ['v'],
        });
    });

    it('reports a missing --base as a null baseSha so main() rejects', () => {
        expect(parseArgs(['--boundary', 'a', '--', 'v']).baseSha).toBeNull();
    });
});

describe('main argument validation', () => {
    // These paths return before any git call, so they exercise main() in-process.
    // main() prints usage to stderr on rejection; silence it for the assertion.
    let err: jest.SpyInstance;
    beforeEach(() => {
        err = jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => err.mockRestore());

    it('rejects a missing --base', () => {
        expect(main(['--head', 'Y', '--boundary', 'a', '--', 'v'])).toBe(1);
    });

    // The PR head sha, never the checked-out HEAD: on a pull_request run that is
    // refs/pull/N/merge, which folds in main's advance and audits a tree the PR
    // does not propose. Requiring the flag makes the wrong ref unreachable.
    it('rejects a missing --head', () => {
        expect(main(['--base', 'X', '--boundary', 'a', '--', 'v'])).toBe(1);
    });

    it('rejects a flag-like token misordered into the --boundary slice', () => {
        // `--boundary a --base sha -- v` slurps --base/sha into the boundary set.
        expect(main(['--boundary', 'a', '--base', 'sha', '--head', 'sha2', '--', 'v'])).toBe(1);
        expect(err).toHaveBeenCalledWith(expect.stringContaining('--base'));
    });
});

describe('segmentation', () => {
    it('round-trips and names every top-level entry, single-line entries included', () => {
        const r = segmentByContainers(BINDINGS_BASE, BINDINGS_CONTAINERS);
        expect(r.error).toBeUndefined();
        const entities = r.segments!.filter(s => s.type === 'entity').map(s => `${s.container}:${s.name}`);
        expect(entities).toEqual([
            'SCOPE_BINDINGS:Person',
            'SCOPE_BINDINGS:FeePayment',
            'SCOPE_BINDINGS:Visit',
            'SCOPE_BINDINGS:RawBadgeLog',
            'ROW_SCOPE_KEY:EmergencyContact',
            'OPT_OUT_PENDING_ROUTE:Corporation',
            'OPT_OUT_PENDING_ROUTE:PersonRole',
        ]);
    });

    it('keys registry calls by endpoint/surface', () => {
        const r = segmentTopLevelCalls(REGISTRY_BASE);
        expect(r.error).toBeUndefined();
        const entities = r.segments!.filter(s => s.type === 'entity').map(s => `${s.container}:${s.name}`);
        expect(entities).toEqual([
            'defineRoute:GET /api/profile',
            'defineRoute:GET /api/fees/payments',
            'defineOutbound:email.admin-notify',
        ]);
    });
});

describe('diffSegmentations', () => {
    const diffBindings = (head: string) =>
        diffSegmentations(segmentByContainers(BINDINGS_BASE, BINDINGS_CONTAINERS), head, s =>
            segmentByContainers(s, BINDINGS_CONTAINERS),
        );

    it('accepts a whole-entry removal', () => {
        expect(diffBindings(bindingsWithoutFeePayment)).toEqual({
            removed: [{ container: 'SCOPE_BINDINGS', name: 'FeePayment' }],
        });
    });

    it('accepts removals from ROW_SCOPE_KEY and OPT_OUT_PENDING_ROUTE, comments included', () => {
        const head = dropLines(
            BINDINGS_BASE,
            [lineOf(BINDINGS_BASE, 'EmergencyContact:'), lineOf(BINDINGS_BASE, 'EmergencyContact:')],
            [lineOf(BINDINGS_BASE, "'Corporation',"), lineOf(BINDINGS_BASE, "'Corporation',")],
        );
        expect(diffBindings(head).removed).toEqual([
            { container: 'ROW_SCOPE_KEY', name: 'EmergencyContact' },
            { container: 'OPT_OUT_PENDING_ROUTE', name: 'Corporation' },
        ]);
    });

    it('REJECTS deleting one element of an all: match — that widens the grant', () => {
        const i = lineOf(BINDINGS_BASE, "{ field: 'departedAt', isNull: true }");
        const head = BINDINGS_BASE.split('\n')
            .map((l, n) => (n === i ? '            all: [{ flag: \'isKeyholder\' }],' : l))
            .join('\n');
        expect(diffBindings(head)).toHaveProperty('error');
    });

    it('rejects editing a surviving entry', () => {
        const head = bindingsWithoutFeePayment.replace("field: 'id'", "field: 'householdId'");
        expect(diffBindings(head)).toHaveProperty('error');
    });

    it('rejects additions', () => {
        const head = BINDINGS_BASE.replace(
            '} as const satisfies ScopeBindings;',
            "    NewModel: { their_own: { field: 'personId', eqCtx: 'selfId' } },\n} as const satisfies ScopeBindings;",
        );
        expect(diffBindings(head)).toHaveProperty('error');
    });

    it('rejects reorders', () => {
        const person = BINDINGS_BASE.split('\n').slice(
            lineOf(BINDINGS_BASE, 'Person: {'),
            lineOf(BINDINGS_BASE, 'Person: {') + 5,
        );
        const head = dropLines(
            BINDINGS_BASE,
            [lineOf(BINDINGS_BASE, 'Person: {'), lineOf(BINDINGS_BASE, 'Person: {') + 4],
        )
            .split('\n')
            .flatMap(l => (l.includes('RawBadgeLog') ? [l, ...person] : [l]))
            .join('\n');
        expect(diffBindings(head)).toHaveProperty('error');
    });

    // A file whose only change the normaliser forgives yields no removals rather
    // than an error — certifyDecommission is what refuses a PR that decommissions
    // nothing anywhere. Pinned here so the two halves stay in step.
    it('reports a no-op diff as zero removals, not an error', () => {
        const r = diffBindings(BINDINGS_BASE);
        expect(r).not.toHaveProperty('error');
        expect(r.removed).toEqual([]);
    });
});

// The exception forgives exactly two edits inside a surviving entry, both of
// which a whole-entity drop forces and neither of which can widen exposure.
// Everything else must still fail byte-strict.
describe('normalizeEntry', () => {
    const same = (a: string, b: string, dropped: string[] = ['Fee']) =>
        normalizeEntry(a, dropped) === normalizeEntry(b, dropped);

    it.each([
        ['a role change', "authorize: { anyRole: ['isBoardMember'] },", "authorize: { anyRole: ['isSysadmin'] },"],
        ['authenticated -> public', "authorize: 'authenticated',", "authorize: 'public',"],
        ['a widened tier', "orderedView: [['a',['public']]],", "orderedView: [['a',['everyones:pii']]],"],
        ['a returns ADDITION', "returns: ['Person'],", "returns: ['Person','Visit'],"],
        ['dropping a model that SURVIVES', "returns: ['Person','Visit'],", "returns: ['Person'],"],
        ['an endpoint change', "endpoint: 'GET /api/a',", "endpoint: 'GET /api/b',"],
    ])('does not forgive %s', (_label, base, head) => {
        expect(same(base, head)).toBe(false);
    });

    it.each([
        ['a line-comment rewrite', "// old\nreturns: ['Person'],", "// new\nreturns: ['Person'],"],
        ['a docblock rewrite', "/**\n * old\n */\nreturns: ['Person'],", "/**\n * new\n */\nreturns: ['Person'],"],
        ['dropping the last returns element', "returns: ['Person', 'Fee'],", "returns: ['Person'],"],
        ['dropping a middle returns element', "returns: ['Fee', 'Person'],", "returns: ['Person'],"],
    ])('forgives %s', (_label, base, head) => {
        expect(same(base, head)).toBe(true);
    });

    // The reason string contents survive: erasing them would make a role or tier
    // edit compare equal to its neighbour, which is what this file exists to catch.
    it('keeps string contents so two different literals never collapse', () => {
        expect(normalizeEntry("authorize: 'public',", [])).toContain("'public'");
    });
});

describe('certifyDecommission', () => {
    const files = (over: Record<string, string | null>) => (p: string) => {
        if (p in over) return over[p];
        if (p === 'checkin-app/src/security/scopeBindings.ts') return BINDINGS_BASE;
        if (p === 'checkin-app/src/security/registry.ts') return REGISTRY_BASE;
        if (p === 'checkin-app/prisma/schema.prisma') return SCHEMA_BASE;
        return null;
    };

    const BINDINGS = 'checkin-app/src/security/scopeBindings.ts';
    const REGISTRY = 'checkin-app/src/security/registry.ts';
    const ROUTE_FILE = 'checkin-app/src/app/api/fees/payments/route.ts';
    const SCHEMA = 'checkin-app/prisma/schema.prisma';
    const MIGRATION = 'checkin-app/prisma/migrations/20260803000000_drop_fee/migration.sql';

    it('certifies the FR7 shape: binding + schema drop + migration in one PR', () => {
        const r = certifyDecommission({
            changed: [
                { status: 'M', path: BINDINGS },
                { status: 'M', path: SCHEMA },
                { status: 'M', path: 'checkin-app/src/security/generated/classifications.ts' },
                { status: 'A', path: MIGRATION },
            ],
            boundaryChanged: [BINDINGS],
            violations: [MIGRATION],
            readBase: files({}),
            readHead: files({ [BINDINGS]: bindingsWithoutFeePayment, [SCHEMA]: SCHEMA_DROPPED }),
        });
        expect(r.reasons).toEqual([]);
        expect(r.ok).toBe(true);
        expect(r.removedModels).toEqual(['FeePayment']);
    });

    it('fails closed on an empty boundary set — omitting --boundary rejects, never certifies', () => {
        const r = certifyDecommission({
            changed: [
                { status: 'M', path: BINDINGS },
                { status: 'M', path: SCHEMA },
                { status: 'A', path: MIGRATION },
            ],
            boundaryChanged: [],
            violations: [MIGRATION],
            readBase: files({}),
            readHead: files({ [BINDINGS]: bindingsWithoutFeePayment, [SCHEMA]: SCHEMA_DROPPED }),
        });
        expect(r.ok).toBe(false);
        expect(r.reasons.join()).toContain('no whole-entry removals found in the boundary diff');
    });

    it('rejects a binding removal whose model survives in the schema', () => {
        const r = certifyDecommission({
            changed: [{ status: 'M', path: BINDINGS }, { status: 'A', path: MIGRATION }],
            boundaryChanged: [BINDINGS],
            violations: [MIGRATION],
            readBase: files({}),
            readHead: files({ [BINDINGS]: bindingsWithoutFeePayment }),
        });
        expect(r.ok).toBe(false);
        expect(r.reasons.join()).toContain('survives in schema.prisma');
    });

    it('rejects any engine-file change outright', () => {
        const r = certifyDecommission({
            changed: [
                { status: 'M', path: BINDINGS },
                { status: 'M', path: 'checkin-app/src/security/scopes.ts' },
            ],
            boundaryChanged: [BINDINGS, 'checkin-app/src/security/scopes.ts'],
            violations: [],
            readBase: files({}),
            readHead: files({ [BINDINGS]: bindingsWithoutFeePayment, [SCHEMA]: SCHEMA_DROPPED }),
        });
        expect(r.ok).toBe(false);
        expect(r.reasons.join()).toContain('scopes.ts');
    });

    it('certifies a route kill only once the verb stops being served', () => {
        const start = lineOf(REGISTRY_BASE, "// Payments history");
        const registryWithoutFees = dropLines(REGISTRY_BASE, [start - 1, start + 9]);

        const ROUTE_BASE = 'export async function GET() {}';

        const attempt = (routeHead: string | null, status: 'M' | 'D') =>
            certifyDecommission({
                changed: [
                    { status: 'M', path: REGISTRY },
                    { status, path: ROUTE_FILE },
                ],
                boundaryChanged: [REGISTRY],
                violations: [ROUTE_FILE],
                readBase: files({ [ROUTE_FILE]: ROUTE_BASE }),
                readHead: files({ [REGISTRY]: registryWithoutFees, [ROUTE_FILE]: routeHead }),
            });

        expect(attempt(ROUTE_BASE, 'M').ok).toBe(false);
        const killed = attempt(null, 'D');
        expect(killed.reasons).toEqual([]);
        expect(killed.ok).toBe(true);
        expect(killed.removedEndpoints).toEqual(['GET /api/fees/payments']);
    });

    it('rejects a route kill whose derived path never served the verb at base', () => {
        const start = lineOf(REGISTRY_BASE, "// Payments history");
        const registryWithoutFees = dropLines(REGISTRY_BASE, [start - 1, start + 9]);

        // A route group, catch-all or `route.tsx` puts the real handler somewhere
        // the derived path does not name. Absent at head then proves nothing, so
        // the certifier must refuse rather than bless a still-live endpoint.
        const r = certifyDecommission({
            changed: [{ status: 'M', path: REGISTRY }],
            boundaryChanged: [REGISTRY],
            violations: [],
            readBase: files({ [ROUTE_FILE]: null }),
            readHead: files({ [REGISTRY]: registryWithoutFees, [ROUTE_FILE]: null }),
        });

        expect(r.ok).toBe(false);
        expect(r.reasons).toEqual([
            'GET /api/fees/payments: checkin-app/src/app/api/fees/payments/route.ts does not export GET at base — endpoint-to-file mapping unverified',
        ]);
    });

    it('rejects outbound-surface removals', () => {
        const start = lineOf(REGISTRY_BASE, 'defineOutbound({');
        const head = dropLines(REGISTRY_BASE, [start - 1, start + 3]);
        const r = certifyDecommission({
            changed: [{ status: 'M', path: REGISTRY }],
            boundaryChanged: [REGISTRY],
            violations: [],
            readBase: files({}),
            readHead: files({ [REGISTRY]: head }),
        });
        expect(r.ok).toBe(false);
        expect(r.reasons.join()).toContain('outbound');
    });

    it('rejects deleting the middleware.ts auth gate — it is a boundary file, not decommissionable app code', () => {
        const MIDDLEWARE = 'checkin-app/src/middleware.ts';
        const r = certifyDecommission({
            changed: [
                { status: 'M', path: BINDINGS },
                { status: 'M', path: SCHEMA },
                { status: 'A', path: MIGRATION },
                { status: 'D', path: MIDDLEWARE },
            ],
            boundaryChanged: [BINDINGS, MIDDLEWARE],
            violations: [MIGRATION, MIDDLEWARE],
            readBase: files({}),
            readHead: files({ [BINDINGS]: bindingsWithoutFeePayment, [SCHEMA]: SCHEMA_DROPPED }),
        });
        expect(r.ok).toBe(false);
        expect(r.reasons.join()).toContain('middleware.ts');
    });

    it('rejects riding-along app code, modified or deleted — only the migration is free', () => {
        const r = certifyDecommission({
            changed: [
                { status: 'M', path: BINDINGS },
                { status: 'M', path: SCHEMA },
                { status: 'A', path: MIGRATION },
                { status: 'D', path: 'checkin-app/src/lib/fees.ts' },
                { status: 'M', path: 'checkin-app/src/lib/membership.ts' },
            ],
            boundaryChanged: [BINDINGS],
            violations: [MIGRATION, 'checkin-app/src/lib/fees.ts', 'checkin-app/src/lib/membership.ts'],
            readBase: files({}),
            readHead: files({ [BINDINGS]: bindingsWithoutFeePayment, [SCHEMA]: SCHEMA_DROPPED }),
        });
        expect(r.ok).toBe(false);
        // fees.ts is a deletion, but this PR removed no route entry, so nothing
        // implies it. A file nothing imports can still be a security control.
        expect(r.reasons.map(x => x.split(':')[0])).toEqual([
            'checkin-app/src/lib/fees.ts',
            'checkin-app/src/lib/membership.ts',
        ]);
        expect(r.reasons[0]).toContain('not a route file of a removed registry entry');
    });

    it('admits the deleted route file of a removed entry, and only that one', () => {
        const start = lineOf(REGISTRY_BASE, "// Payments history");
        const registryWithoutFees = dropLines(REGISTRY_BASE, [start - 1, start + 9]);

        const r = certifyDecommission({
            changed: [
                { status: 'M', path: REGISTRY },
                { status: 'D', path: ROUTE_FILE },
                { status: 'D', path: 'checkin-app/src/lib/fees.ts' },
            ],
            boundaryChanged: [REGISTRY],
            violations: [ROUTE_FILE, 'checkin-app/src/lib/fees.ts'],
            readBase: files({ [ROUTE_FILE]: 'export async function GET() {}' }),
            readHead: files({ [REGISTRY]: registryWithoutFees, [ROUTE_FILE]: null }),
        });

        expect(r.ok).toBe(false);
        expect(r.reasons).toHaveLength(1);
        expect(r.reasons[0]).toContain('checkin-app/src/lib/fees.ts');
    });
});
