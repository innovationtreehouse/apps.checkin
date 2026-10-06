import type { JWT } from 'next-auth/jwt';
import { assignParticipantClaims, type ClaimSourceParticipant } from '@/lib/authClaims';

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
        assignParticipantClaims(token, participant({ household: { orgMembership: { status: 'DENIED' } } }));

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
        assignParticipantClaims(token, participant());

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
            assignParticipantClaims(token, participant({ household }));

            expect(token.denied).toBe(false);
            expect(token.isKeyholder).toBe(true);
        },
    );
});

describe('assignParticipantClaims — claims derive from PersonRole rows', () => {
    it('no rows ⇒ every authority flag false', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ roles: [] }));

        expect(token.isSysadmin).toBe(false);
        expect(token.isBoardMember).toBe(false);
        expect(token.isKeyholder).toBe(false);
        expect(token.isBackgroundCheckReviewer).toBe(false);
        expect(token.isOperations).toBe(false);
    });

    it('one row ⇒ only that flag is true', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ roles: [{ role: 'BOARD' }] }));

        expect(token.isBoardMember).toBe(true);
        expect(token.isSysadmin).toBe(false);
        expect(token.isKeyholder).toBe(false);
        expect(token.isBackgroundCheckReviewer).toBe(false);
        expect(token.isOperations).toBe(false);
    });

    it('a grant (row added) flips the claim true on the next stamp', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ roles: [] }));
        expect(token.isOperations).toBe(false);

        // Simulates a refresh after PATCH /api/roles granted OPERATIONS.
        assignParticipantClaims(token, participant({ roles: [{ role: 'OPERATIONS' }] }));
        expect(token.isOperations).toBe(true);
    });

    it('a revoke (row removed) flips the claim false on the next stamp', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ roles: [{ role: 'KEYHOLDER' }] }));
        expect(token.isKeyholder).toBe(true);

        // Simulates a refresh after PATCH /api/roles revoked KEYHOLDER.
        assignParticipantClaims(token, participant({ roles: [] }));
        expect(token.isKeyholder).toBe(false);
    });
});

describe('assignParticipantClaims — householdLead claim', () => {
    it('stamps householdLead=true when isHouseholdLead is set', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ isHouseholdLead: true }));
        expect(token.householdLead).toBe(true);
    });

    it('stamps householdLead=false when isHouseholdLead is unset', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ isHouseholdLead: false }));
        expect(token.householdLead).toBe(false);
    });

    it('forces householdLead=false for a DENIED household even when isHouseholdLead is set', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({
            isHouseholdLead: true,
            household: { orgMembership: { status: 'DENIED' } },
        }));
        expect(token.householdLead).toBe(false);
    });
});

describe('assignParticipantClaims — canAccessStaging claim (ops-stg gate)', () => {
    it('stamps canAccessStaging=true when the Person column is set', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ canAccessStaging: true }));
        expect(token.canAccessStaging).toBe(true);
    });

    it('stamps canAccessStaging=false when the Person column is unset', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({ canAccessStaging: false }));
        expect(token.canAccessStaging).toBe(false);
    });

    it('forces canAccessStaging=false for a DENIED household even when the column is true', () => {
        const token = {} as JWT;
        assignParticipantClaims(token, participant({
            canAccessStaging: true,
            household: { orgMembership: { status: 'DENIED' } },
        }));
        expect(token.canAccessStaging).toBe(false);
    });
});
