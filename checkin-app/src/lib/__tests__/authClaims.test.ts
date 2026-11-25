import type { JWT } from 'next-auth/jwt';
import { assignParticipantClaims, type ClaimSourceParticipant } from '@/lib/authClaims';
import { calendarDayIn } from '@/lib/time';

const today = new Date('2026-10-12T00:00:00.000Z');

const ALL_ROLES: ClaimSourceParticipant['roles'] = [
    { role: 'SYSADMIN' },
    { role: 'BOARD' },
    { role: 'KEYHOLDER' },
    { role: 'BG_REVIEWER' },
    { role: 'OPERATIONS' },
];

function participant(overrides: Partial<ClaimSourceParticipant> = {}): ClaimSourceParticipant {
    return {
        id: 7,
        roles: ALL_ROLES,
        householdId: 99,
        isHouseholdLead: false,
        dateOfBirth: new Date('1990-01-01'),
        isDeclaredAdult: false,
        toolStatuses: [{ toolId: 1, level: 'CERTIFIED' }],
        household: { orgMembership: { status: 'ACTIVE' } },
        canAccessStaging: false,
        ...overrides,
    };
}

describe('assignParticipantClaims — household login gate', () => {
    it('forces denied=true and strips every authority flag for a DENIED household', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ household: { orgMembership: { status: 'DENIED' } } }), today);

        expect(token.denied).toBe(true);
        expect(token.isSysadmin).toBe(false);
        expect(token.isKeyholder).toBe(false);
        expect(token.isBoardMember).toBe(false);
        expect(token.isBackgroundCheckReviewer).toBe(false);
        expect(token.isOperations).toBe(false);
        expect(token.toolStatuses).toEqual([]);
        // Identity is preserved so the session still resolves and the gate can act.
        expect(token.id).toBe(7);
        expect(token.householdId).toBe(99);
    });

    it('preserves roles for an ACTIVE household', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant(), today);

        expect(token.denied).toBe(false);
        expect(token.isSysadmin).toBe(true);
        expect(token.isKeyholder).toBe(true);
        expect(token.isOperations).toBe(true);
        expect(token.toolStatuses).toHaveLength(1);
    });

    it.each(['NONE', 'REVOKED', undefined] as const)(
        'does not deny for non-DENIED status: %s',
        (status) => {
            const token = {} as JWT;
            const household = status === undefined ? null : { orgMembership: { status } };
            assignParticipantClaims(token, participant({ household }), today);

            expect(token.denied).toBe(false);
            expect(token.isSysadmin).toBe(true);
        },
    );
});

describe('assignParticipantClaims — keyholder authority follows household status', () => {
    it.each([
        ['ACTIVE', true],
        ['NONE', true],
        ['REVOKED', false],
        ['DENIED', false],
    ] as const)('%s household: isKeyholder=%s', (status, expected) => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ household: { orgMembership: { status } } }), today);
        expect(token.isKeyholder).toBe(expected);
    });

    it('a REVOKED household keeps every other role flag', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ household: { orgMembership: { status: 'REVOKED' } } }), today);
        expect(token.isBoardMember).toBe(true);
        expect(token.isOperations).toBe(true);
        expect(token.toolStatuses).toHaveLength(1);
    });
});

describe('assignParticipantClaims — open household question', () => {
    it('stamps nothing of the record until it is answered', () => {
        const token = { name: 'Name Google gave' } as JWT;
        assignParticipantClaims(token, participant({ householdJoinPending: true, name: 'Name the household typed', isHouseholdLead: true, canAccessStaging: true }), today);
        expect(token).toMatchObject({
            householdJoinPending: true, denied: false, name: null, householdId: null, householdLead: false,
            ageBand: 'unknown', toolStatuses: [], programsLed: [], canAccessStaging: false, isSysadmin: false, isBoardMember: false,
        });
    });

    it('gives the record back after a yes', () => {
        const token = { name: null } as JWT;
        assignParticipantClaims(token, participant({ name: 'Ana' }), today);
        expect(token).toMatchObject({ householdJoinPending: false, name: 'Ana', householdId: 99, isBoardMember: true });
    });
});

describe('assignParticipantClaims — age band', () => {
    it("takes the band from the org's day, so an 18th birthday turns at the org's midnight", () => {
        // 12:30 AM on the 12th in New York, 11:30 PM on the 11th in Chicago.
        const instant = '2026-10-12T04:30:00.000Z';
        const turns18 = participant({ dateOfBirth: new Date('2008-10-12T00:00:00.000Z') });
        const newYork = {} as JWT;
        assignParticipantClaims(newYork, turns18, calendarDayIn(instant, 'America/New_York'));
        expect(newYork.ageBand).toBe('adult');
        const chicago = {} as JWT;
        assignParticipantClaims(chicago, turns18, calendarDayIn(instant, 'America/Chicago'));
        expect(chicago.ageBand).toBe('youth');
    });
});

describe('assignParticipantClaims — age step', () => {
    it('asks for an age while someone who created a household has none on file', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ ageStepPending: true, dateOfBirth: null, isDeclaredAdult: false }), today);
        expect(token.ageStepPending).toBe(true);
    });

    it('stops asking once an age is on file', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ ageStepPending: true, dateOfBirth: null, isDeclaredAdult: true }), today);
        expect(token.ageStepPending).toBe(false);
    });

    it('never asks someone who did not create a household at sign-in', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ dateOfBirth: null, isDeclaredAdult: false }), today);
        expect(token.ageStepPending).toBe(false);
    });

    it('waits for an open household question first', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ ageStepPending: true, householdJoinPending: true, dateOfBirth: null, isDeclaredAdult: false }), today);
        expect(token.ageStepPending).toBe(false);
    });
});

describe('assignParticipantClaims — claims derive from PersonRole rows', () => {
    it('no rows ⇒ every authority flag false', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ roles: [] }), today);

        expect(token.isSysadmin).toBe(false);
        expect(token.isBoardMember).toBe(false);
        expect(token.isKeyholder).toBe(false);
        expect(token.isBackgroundCheckReviewer).toBe(false);
        expect(token.isOperations).toBe(false);
    });

    it('one row ⇒ only that flag is true', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ roles: [{ role: 'BOARD' }] }), today);

        expect(token.isBoardMember).toBe(true);
        expect(token.isSysadmin).toBe(false);
        expect(token.isKeyholder).toBe(false);
        expect(token.isBackgroundCheckReviewer).toBe(false);
        expect(token.isOperations).toBe(false);
    });

    it('a grant (row added) flips the claim true on the next stamp', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ roles: [] }), today);
        expect(token.isOperations).toBe(false);

        // Simulates a refresh after PATCH /api/roles granted OPERATIONS.
        assignParticipantClaims(token, participant({ roles: [{ role: 'OPERATIONS' }] }), today);
        expect(token.isOperations).toBe(true);
    });

    it('a revoke (row removed) flips the claim false on the next stamp', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ roles: [{ role: 'KEYHOLDER' }] }), today);
        expect(token.isKeyholder).toBe(true);

        // Simulates a refresh after PATCH /api/roles revoked KEYHOLDER.
        assignParticipantClaims(token, participant({ roles: [] }), today);
        expect(token.isKeyholder).toBe(false);
    });
});

describe('assignParticipantClaims — householdLead claim', () => {
    it('stamps householdLead=true when isHouseholdLead is set', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ isHouseholdLead: true }), today);
        expect(token.householdLead).toBe(true);
    });

    it('stamps householdLead=false when isHouseholdLead is unset', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ isHouseholdLead: false }), today);
        expect(token.householdLead).toBe(false);
    });

    it('forces householdLead=false for a DENIED household even when isHouseholdLead is set', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({
            isHouseholdLead: true,
            household: { orgMembership: { status: 'DENIED' } },
        }), today);
        expect(token.householdLead).toBe(false);
    });
});

describe('assignParticipantClaims — canAccessStaging claim (ops-stg gate)', () => {
    it('stamps canAccessStaging=true when the Person column is set', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ canAccessStaging: true }), today);
        expect(token.canAccessStaging).toBe(true);
    });

    it('stamps canAccessStaging=false when the Person column is unset', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ canAccessStaging: false }), today);
        expect(token.canAccessStaging).toBe(false);
    });

    it('forces canAccessStaging=false for a DENIED household even when the column is true', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({
            canAccessStaging: true,
            household: { orgMembership: { status: 'DENIED' } },
        }), today);
        expect(token.canAccessStaging).toBe(false);
    });
});

describe('assignParticipantClaims — Treehouse Volunteer inputs', () => {
    const volunteer = {
        programVolunteers: [{ programId: 4 }],
    };

    it('stamps program volunteer, volunteer family and active membership', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ ...volunteer, household: { orgMembership: { status: 'ACTIVE', isVolunteerFamily: true } } }), today);

        expect(token.isProgramVolunteer).toBe(true);
        expect(token.isVolunteerFamily).toBe(true);
        expect(token.isActiveOrgMember).toBe(true);
    });

    it('reads a lapsed membership as inactive', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ ...volunteer, household: { orgMembership: { status: 'REVOKED', isVolunteerFamily: true } } }), today);

        expect(token.isActiveOrgMember).toBe(false);
        expect(token.isVolunteerFamily).toBe(true);
    });

    it('forces every input false for a DENIED household', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ ...volunteer, household: { orgMembership: { status: 'DENIED', isVolunteerFamily: true } } }), today);

        expect(token.isProgramVolunteer).toBe(false);
        expect(token.isVolunteerFamily).toBe(false);
        expect(token.isActiveOrgMember).toBe(false);
    });
});
