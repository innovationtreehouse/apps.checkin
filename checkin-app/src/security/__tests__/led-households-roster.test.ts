/**
 * @jest-environment node
 */
/**
 * led_households roster resolves from the DB, not the JWT claim (#1614).
 *
 * The write authz (visitSubject → householdLeadship, DB, sysadmin-inclusive)
 * and the view roster (buildCallerContext → ctx.ledHouseholdMemberIds) must
 * read the SAME predicate, or a write lands while the response is stripped of
 * its `personal` fields (arrivedAt/departedAt). buildCallerContext used to gate
 * the roster on the `auth.user.householdLead` session claim, which has no
 * sysadmin leg and goes stale — strictly narrower than canManage.
 *
 * These pin the roster prefetch (the transitive path that feeds led_households)
 * against buildCallerContext directly, since the hand-built CallerContext in
 * visit-household-lead-scope.test.ts cannot see this gate.
 */
import prisma from '@/lib/prisma';
import { buildCallerContext } from '../access-resolvers';
import { stripValue } from '../stripper';
import { LIVE_PERSON } from '@/lib/person/filters';
import type { CtxNeeds, Token } from '../core';
import type { AuthResult } from '@/types/auth';

// A route whose only row-scoped grant is led_households: the roster prefetch
// and nothing else (what deriveCtxNeeds yields for /api/attendance/manual/[id]).
const LED_ONLY: CtxNeeds = {
    programs: false,
    programHouseholds: false,
    programEvents: false,
    activeVisitors: false,
    ledHouseholdMembers: true,
};

// The view the registry grants both /api/attendance/manual/[id] verbs.
const VIEW: Token[] = ['their_own:personal', 'led_households:personal', 'member', 'public'];

// Household 2 = people 5, 6, 9. The row under test belongs to 9, so the caller
// (5) is never the owner — their_own can't mask what led_households grants.
const memberVisit = { id: 1, personId: 9, arrivedAt: new Date(0), departedAt: new Date(1), deletedAt: null };
const HOUSEHOLD_2 = [{ id: 5 }, { id: 6 }, { id: 9 }];

function sessionAuth(id: number, householdLeadClaim: boolean): AuthResult {
    return {
        type: 'session',
        user: {
            id,
            householdId: 2,
            isSysadmin: false,
            isBoardMember: false,
            isKeyholder: false,
            isBackgroundCheckReviewer: false,
            isOperations: false,
            householdLead: householdLeadClaim,
        },
    };
}

/** Stub householdLeadship's findUnique + the roster findMany. */
function mockDb(row: { isHouseholdLead: boolean; isSysadmin: boolean } | null) {
    const findUnique = jest.fn().mockResolvedValue(row && { householdId: 2, ...row });
    const findMany = jest.fn().mockResolvedValue(HOUSEHOLD_2);
    prisma.person.findUnique = findUnique;
    prisma.person.findMany = findMany;
    return { findUnique, findMany };
}

describe('ledHouseholdMemberIds prefetch reads canManage from the DB', () => {
    it('populates the roster for a sysadmin who is NOT a household lead', async () => {
        // Case (a) in #1614: the sysadmin override makes canManage true even
        // though isHouseholdLead is false, so the roster — and led_households —
        // must resolve for their own household.
        const { findUnique, findMany } = mockDb({ isHouseholdLead: false, isSysadmin: true });

        const ctx = await buildCallerContext(sessionAuth(5, false), LED_ONLY);

        expect(findUnique).toHaveBeenCalledWith({
            where: { id: 5 },
            select: { householdId: true, isHouseholdLead: true, isSysadmin: true },
        });
        expect(findMany).toHaveBeenCalledWith({
            where: { householdId: 2, ...LIVE_PERSON },
            select: { id: true },
        });
        expect([...ctx.ledHouseholdMemberIds].sort()).toEqual([5, 6, 9]);

        const out = stripValue('Visit', memberVisit, VIEW, ctx) as Record<string, unknown>;
        expect(out.arrivedAt).toEqual(memberVisit.arrivedAt);
        expect(out.departedAt).toEqual(memberVisit.departedAt);
    });

    it('leaves the roster empty for a genuine non-lead household member', async () => {
        // The invariant led_households exists to enforce: sharing a household is
        // not leading it. canManage is false, so the findMany never runs.
        const { findMany } = mockDb({ isHouseholdLead: false, isSysadmin: false });

        const ctx = await buildCallerContext(sessionAuth(6, false), LED_ONLY);

        expect(findMany).not.toHaveBeenCalled();
        expect(ctx.ledHouseholdMemberIds.size).toBe(0);

        const out = stripValue('Visit', memberVisit, VIEW, ctx) as Record<string, unknown>;
        expect(out).not.toHaveProperty('arrivedAt');
        expect(out).not.toHaveProperty('departedAt');
        expect(out.personId).toBe(9); // public tier still rides through
    });

    it('populates the roster for a stale-JWT lead (claim false, DB true)', async () => {
        // Case (b): promoted to lead after the token was minted. The claim says
        // not-lead; the DB says lead. Reading the DB is what fixes it.
        mockDb({ isHouseholdLead: true, isSysadmin: false });

        const ctx = await buildCallerContext(sessionAuth(5, false), LED_ONLY);

        expect([...ctx.ledHouseholdMemberIds].sort()).toEqual([5, 6, 9]);
        const out = stripValue('Visit', memberVisit, VIEW, ctx) as Record<string, unknown>;
        expect(out.arrivedAt).toEqual(memberVisit.arrivedAt);
    });

    it('leaves the roster empty when the caller has no household', async () => {
        const { findMany } = mockDb(null); // householdLeadship returns null

        const ctx = await buildCallerContext(sessionAuth(77, false), LED_ONLY);

        expect(findMany).not.toHaveBeenCalled();
        expect(ctx.ledHouseholdMemberIds.size).toBe(0);
    });
});
