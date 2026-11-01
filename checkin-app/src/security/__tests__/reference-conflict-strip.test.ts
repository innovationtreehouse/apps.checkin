/**
 * @jest-environment node
 *
 * The conflicts page reads where a part is now from the conflict's itemReference
 * relation, so that item must survive the stripper for every catalog viewer.
 */
import { stripBag } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';
import type { Token } from '@/security/core';

const ctx: CallerContext = {
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

describe('stripper — ReferenceConflict', () => {
    it('keeps the raised item and the current item under the public view', () => {
        const row = { id: 1, existingGtin13: 'raised', proposedGtin13: 'proposed', itemReference: { gtin13: 'current' } };
        const tokens: readonly Token[] = ['public'];
        expect(stripBag({ ReferenceConflict: [row] }, tokens, ctx)).toEqual({ ReferenceConflict: [row] });
    });
});
