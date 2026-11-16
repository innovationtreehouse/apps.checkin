/**
 * @jest-environment node
 */
/**
 * The board's trusted-adult queue (GET /api/safety/trusted-adults) carries the
 * linked adult's household id, which the page's conflict check reads.
 */
import { stripValue } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';
import { getRoute } from '@/security/core';
import '@/security/registry';

const ctx: CallerContext = {
    selfId: 1,
    householdId: 10,
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

describe('trusted-adult queue strip', () => {
    it.each(['isSysadmin', 'isBoardMember'])('passes the linked adult with their household id to %s', (role) => {
        const view = getRoute('GET /api/safety/trusted-adults')?.orderedView.find(([r]) => r === role)?.[1];
        expect(view).toBeDefined();
        const row = {
            id: 1,
            trustedAdultEmail: 'sam@example.com',
            trustedAdultPerson: { id: 2, name: 'Sam Spouse', email: 'sam@example.com', householdId: 10 },
        };
        expect(stripValue('TrustedAdult', row, view!, ctx)).toEqual(row);
    });
});
