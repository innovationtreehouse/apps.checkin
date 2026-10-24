/**
 * @jest-environment node
 *
 * A scalar in a model position (a bag value or a relation) carries no field name
 * to classify, so the stripper drops it rather than passing it through.
 */
import { stripBag, stripValue } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';
import type { Token } from '@/security/core';

function ctx(): CallerContext {
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
    };
}

const NONE: readonly Token[] = [];
const ALL = ['public', 'member', 'everyones:pii', 'everyones:personal', 'everyones:internal'] as Token[];

beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

describe('stripper — scalars in a model position', () => {
    it.each(['jane@example.org', 42, true])('drops a bare %p bag value', (scalar) => {
        expect(stripBag({ Person: scalar }, NONE, ctx())).toEqual({ Person: null });
    });

    it('drops scalars inside a model array', () => {
        expect(stripValue('Person', ['jane@example.org', 7], NONE, ctx())).toEqual([null, null]);
    });

    it('drops a scalar where a relation row belongs, whatever the tokens', () => {
        const out = stripValue('Visit', { id: 1, person: 'jane@example.org' }, ALL, ctx()) as Record<string, unknown>;
        expect(out.person).toBeNull();
    });

    it('still passes null and undefined through', () => {
        expect(stripValue('Person', null, NONE, ctx())).toBeNull();
        expect(stripValue('Person', undefined, NONE, ctx())).toBeUndefined();
    });
});
