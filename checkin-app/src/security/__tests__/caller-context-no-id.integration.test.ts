/**
 * @jest-environment node
 */
/**
 * buildCallerContext must not widen when a session carries no numeric id.
 *
 * Prisma drops a `where` key whose value is undefined, so an id-less session
 * would read `program.findMany({ where: { leadMentorId: undefined } })` as
 * "every program" and land in every program-lead-mentor grant. This runs
 * against a real database because the filter-dropping is Prisma's behaviour.
 */
import prisma from '@/lib/prisma';
import { buildCallerContext } from '../access-resolvers';
import type { CtxNeeds } from '../core';
import type { AuthResult } from '@/types/auth';

const TAG = 'caller-ctx-no-id';
// Program scopes only: householdLeadship's findUnique already throws on an
// undefined id, so the roster prefetch would mask the widening under test.
const PROGRAM_NEEDS: CtxNeeds = {
    programs: true,
    programHouseholds: true,
    programEvents: true,
    activeVisitors: false,
    ledHouseholdMembers: false,
};

function sessionAuth(id: number): Extract<AuthResult, { type: 'session' }> {
    return {
        type: 'session',
        user: {
            id,
            isSysadmin: false,
            isBoardMember: false,
            isKeyholder: false,
            isBackgroundCheckReviewer: false,
            isOperations: false,
            isInventoryManager: false,
        },
    };
}

describe('buildCallerContext with a session lacking a numeric id', () => {
    let leadId: number;
    let programId: number;

    beforeAll(async () => {
        const lead = await prisma.person.create({
            data: { email: `lead-${TAG}@example.com`, name: 'Lead', household: { create: { name: TAG } } },
        });
        leadId = lead.id;
        const program = await prisma.program.create({
            data: { name: TAG, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), phase: 'RUNNING', leadMentorId: leadId },
        });
        programId = program.id;
    });

    afterAll(async () => {
        await prisma.program.deleteMany({ where: { name: TAG } });
        const lead = await prisma.person.findUnique({ where: { id: leadId }, select: { householdId: true } });
        await prisma.person.deleteMany({ where: { id: leadId } });
        if (lead?.householdId) await prisma.household.deleteMany({ where: { id: lead.householdId } });
    });

    it.each([
        ['undefined', undefined],
        ['the dev guest id', 'guest'],
    ])('resolves no program scope for id %s', async (_label, id) => {
        // The session type promises a numeric id; this is the runtime value it gets
        // when the jwt re-sync empties the token.
        const auth = sessionAuth(0);
        Object.assign(auth.user, { id });

        const ctx = await buildCallerContext(auth, PROGRAM_NEEDS);

        expect(ctx.programsLed.has(programId)).toBe(false);
        expect(ctx.programsLed.size).toBe(0);
        expect(ctx.programsCoreVolIn.size).toBe(0);
        expect(ctx.participantIdsInScopePrograms.size).toBe(0);
        expect(ctx.householdIdsInScopePrograms.size).toBe(0);
        expect(ctx.eventIdsInScopePrograms.size).toBe(0);
    });

    it('still resolves the real lead', async () => {
        const ctx = await buildCallerContext(sessionAuth(leadId), PROGRAM_NEEDS);

        expect([...ctx.programsLed]).toEqual([programId]);
    });
});
