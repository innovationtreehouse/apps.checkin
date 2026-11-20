/**
 * @jest-environment node
 *
 * The corrections page marks a merged-away person from their survivor's
 * mergedArchive, so that relation must survive the stripper under the route's view.
 */
import { stripBag } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';
import { getRoute } from '@/security/core';
import '@/security/registry';

const ctx: CallerContext = {
    selfId: 1,
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

describe('stripper — GET /api/facility/corrections', () => {
    const route = getRoute('GET /api/facility/corrections');

    it.each(route?.orderedView ?? [])('keeps the survivor\'s merge archive for %s', (_role, tokens) => {
        const people = [{ id: 3, name: 'Survivor', mergedArchive: [{ fromId: 4, toId: 3 }] }, { id: 4, name: 'Merged away' }];
        expect(stripBag({ Person: people }, tokens, ctx)).toEqual({ Person: people });
    });

    it('drops a bare survivor id on a Person entry', () => {
        const [[, tokens]] = route!.orderedView;
        expect(stripBag({ Person: [{ id: 4, name: 'Merged away', survivorId: 3 }] }, tokens, ctx))
            .toEqual({ Person: [{ id: 4, name: 'Merged away' }] });
    });
});
