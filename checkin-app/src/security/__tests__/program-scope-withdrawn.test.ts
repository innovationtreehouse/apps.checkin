/**
 * @jest-environment node
 */
/**
 * A withdrawn enrollment grants a program's lead and core volunteers nothing.
 *
 * A WITHDRAWN ProgramParticipant row stays as history, so the program-scope
 * prefetch in buildCallerContext must ask only for enrolled participants:
 * participantIdsInScopePrograms is built from exactly what the query returns.
 */
import prisma from '@/lib/prisma';
import { buildCallerContext } from '../access-resolvers';
import { ENROLLED_PARTICIPANT } from '@/lib/person/filters';
import type { CtxNeeds } from '../core';
import type { AuthResult } from '@/types/auth';

const leadAuth: AuthResult = {
    type: 'session',
    user: {
        id: 12,
        householdId: 6,
        isSysadmin: false,
        isBoardMember: false,
        isKeyholder: false,
        isBackgroundCheckReviewer: false,
        isOperations: false,
        isInventoryManager: false,
    },
};

const PROGRAMS_ONLY: CtxNeeds = {
    programs: true,
    programHouseholds: false,
    programEvents: false,
    activeVisitors: false,
    ledHouseholdMembers: false,
};

const ENROLLED_PERSON_IDS = { where: ENROLLED_PARTICIPANT, select: { personId: true } };

describe('program-scope prefetch reads only enrolled participants', () => {
    it('filters led and core-volunteered programs by ENROLLED_PARTICIPANT', async () => {
        const programFindMany = jest.fn().mockResolvedValue([{ id: 1, participants: [{ personId: 9 }] }]);
        const volunteerFindMany = jest
            .fn()
            .mockResolvedValue([{ programId: 2, program: { participants: [{ personId: 10 }] } }]);
        prisma.program.findMany = programFindMany;
        prisma.programVolunteer.findMany = volunteerFindMany;

        const built = await buildCallerContext(leadAuth, PROGRAMS_ONLY);

        expect(programFindMany).toHaveBeenCalledWith({
            where: { leadMentorId: 12 },
            select: { id: true, participants: ENROLLED_PERSON_IDS },
        });
        expect(volunteerFindMany).toHaveBeenCalledWith({
            where: { personId: 12, isCore: true },
            select: { programId: true, program: { select: { participants: ENROLLED_PERSON_IDS } } },
        });
        expect(built.participantIdsInScopePrograms).toEqual(new Set([9, 10]));
    });
});
