/**
 * @jest-environment node
 */
/**
 * Boundary coverage for the reviewer queue (GET /api/membership/reviews). Every item
 * is a check review: its person, and for a review a household asked for, that
 * household's name, intake note and leads. All of it reaches a reviewer; a field
 * the route never selects is still stripped if it slips in.
 */
import { stripValue } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';
import { getRoute, type Token } from '@/security/core';
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

const REVIEWER_VIEW: readonly Token[] = ['everyones:pii', 'member', 'public'];

const strip = (row: object) => stripValue('OrgMembershipProcess', row, REVIEWER_VIEW, ctx) as Record<string, unknown>;

describe('reviewer queue strip', () => {
    it('grants reviewers and the Board the pii view over the models it returns', () => {
        const route = getRoute('GET /api/membership/reviews');
        expect(route?.returns).toEqual(expect.arrayContaining(['OrgMembershipProcess', 'Household', 'Person']));
        expect(route?.orderedView).toEqual([
            ['isBackgroundCheckReviewer', REVIEWER_VIEW],
            ['isBoardMember', REVIEWER_VIEW],
        ]);
    });

    it('passes a review a household asked for, with no person yet, whole', () => {
        const row = {
            id: 9,
            subjectPerson: null,
            requestedForHousehold: {
                name: 'Rivera household',
                intakeNotes: 'Volunteer only, no students.',
                householdMembers: [{ id: 3, name: 'Ana Rivera', email: 'ana@example.com' }],
            },
            _count: { attestations: 0 },
        };
        expect(strip(row)).toEqual(row);
    });

    it('passes a named review whole', () => {
        const row = {
            id: 10,
            subjectPerson: { id: 3, name: 'Ana Rivera', householdId: 4, household: { name: 'Rivera household' } },
            requestedForHousehold: { name: 'Rivera household', intakeNotes: null, householdMembers: [{ id: 3, name: 'Ana Rivera', email: 'ana@example.com' }] },
            _count: { attestations: 1 },
        };
        expect(strip(row)).toEqual(row);
    });

    it('strips a lead field above the reviewer view if one is ever selected', () => {
        const row = {
            id: 11,
            subjectPerson: null,
            requestedForHousehold: { name: 'Rivera household', householdMembers: [{ id: 3, name: 'Ana Rivera', dateOfBirth: new Date('1980-01-01') }] },
        };
        const stripped = strip(row) as { requestedForHousehold: { householdMembers: Record<string, unknown>[] } };
        expect(stripped.requestedForHousehold.householdMembers[0]).not.toHaveProperty('dateOfBirth');
    });
});
