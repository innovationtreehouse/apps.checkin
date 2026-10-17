/**
 * @jest-environment node
 */
/**
 * The eligible-participants staff search returns names only: an
 * EligibleCandidate row keeps id, name and the computed age label, and drops
 * any contact or date-of-birth field a query might over-select.
 */
import '@/security/registry';
import { stripValue } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';

function ctx(): CallerContext {
    return {
        selfId: undefined,
        householdId: undefined,
        isKeyholder: false,
        isKiosk: false,
        programsLed: new Set([1]),
        programsCoreVolIn: new Set(),
        participantIdsInScopePrograms: new Set(),
        householdIdsInScopePrograms: new Set(),
        eventIdsInScopePrograms: new Set(),
        activeVisitorIds: new Set(),
        ledHouseholdMemberIds: new Set(),
    };
}

it('keeps id, name and ageWarning; drops email and dateOfBirth', () => {
    const row = { id: 5, name: 'Kiki Kid', ageWarning: 'Too young', email: 'kiki@example.com', dateOfBirth: '2018-01-01', phone: '5125550000' };
    expect(stripValue('EligibleCandidate', row, ['public'], ctx())).toEqual({ id: 5, name: 'Kiki Kid', ageWarning: 'Too young' });
});
