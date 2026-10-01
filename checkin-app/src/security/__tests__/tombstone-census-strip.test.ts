/**
 * @jest-environment node
 */
/**
 * Strip round-trip for GET /api/membership-ops/participants/tombstones (#1823
 * review: the registry view only granted pii+public, so PersonMerge.fromId and
 * the internal-tier `roles`/`rawBadgeLogs` relation counts were silently
 * dropped by the stripper — every tombstone read "no archive" and the
 * no-pathway total under-reported). Pulls the live view tokens from the
 * registry so this tracks any future policy edit, per the payment-plans
 * precedent (payment-plans-strip.test.ts).
 */
import { stripBag } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';
import { getRoute, type Role, type Token } from '@/security/core';
import '@/security/registry';

function ctx(opts: Partial<CallerContext> = {}): CallerContext {
    return {
        selfId: undefined,
        householdId: undefined,
        isKeyholder: false,
        isKiosk: false,
        programsLed: new Set(),
        programsCoreVolIn: new Set(),
        participantIdsInScopePrograms: new Set(),
        householdIdsInScopePrograms: new Set(),
        eventIdsInScopePrograms: new Set(),
        activeVisitorIds: new Set(),
        ledHouseholdMemberIds: new Set(),
        ...opts,
    };
}

function tokensFor(endpoint: string, role: Role): readonly Token[] {
    const spec = getRoute(endpoint);
    if (!spec) throw new Error(`no registry entry for ${endpoint}`);
    const entry = spec.orderedView.find(([r]) => r === role);
    if (!entry) throw new Error(`no orderedView entry for ${role} on ${endpoint}`);
    return entry[1];
}

const ENDPOINT = 'GET /api/membership-ops/participants/tombstones';

const bag = {
    Person: [
        {
            id: 5,
            name: 'Tombstoned Person',
            email: 'gone@x.test',
            mergedInto: { id: 9, name: 'Survivor' },
            _count: { programParticipants: 1, roles: 2, rawBadgeLogs: 3, mergedFrom: 0 },
        },
    ],
    PersonMerge: [{ fromId: 5 }],
};

describe.each(['isSysadmin', 'isBoardMember'] as const)(
    'tombstone census field-stripping (%s)',
    (role) => {
        it('keeps PersonMerge.fromId so the page can tell archived from not', () => {
            const tokens = tokensFor(ENDPOINT, role);
            const out = stripBag(bag, tokens, ctx());
            expect(out.PersonMerge).toEqual([{ fromId: 5 }]);
        });

        it('keeps the internal-tier roles/rawBadgeLogs counts alongside the public ones', () => {
            const tokens = tokensFor(ENDPOINT, role);
            const out = stripBag(bag, tokens, ctx());
            const person = (out.Person as Array<Record<string, unknown>>)[0];
            expect(person._count).toEqual({
                programParticipants: 1,
                roles: 2,
                rawBadgeLogs: 3,
                mergedFrom: 0,
            });
        });

        it('requires everyones:internal — guards the assumption the fix rests on', () => {
            const tokens = tokensFor(ENDPOINT, role);
            expect(tokens).toContain('everyones:internal');
        });
    },
);
