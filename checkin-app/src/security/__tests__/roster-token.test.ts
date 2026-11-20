/**
 * @jest-environment node
 */
/**
 * The `roster` token: a route lists the models whose rows say who is enrolled
 * (`rosterModels`), and only a view holding `roster` receives them. On
 * GET /api/programs/[id] that is staff and an enrolled household; everyone else
 * gets the program and its counts with no roster rows.
 */
import { stripBag } from '@/security/stripper';
import { callerHoldsRole, type CallerContext } from '@/security/access-resolvers';
import {
    defineFileRoute,
    defineRoute,
    fieldVisible,
    getRoute,
    hiddenRosterModels,
    parseToken,
    rosterDeclarationError,
    type Role,
    type Token,
} from '@/security/core';
import type { AuthResult, AuthenticatedUser } from '@/types/auth';
import '@/security/registry';

const PROGRAM = 'GET /api/programs/[id]';

function ctx(opts: Partial<CallerContext> = {}): CallerContext {
    return {
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
        ...opts,
    };
}

function session(id: number): AuthResult {
    const user: AuthenticatedUser = {
        id,
        email: `p${id}@example.com`,
        isSysadmin: false,
        isBoardMember: false,
        isKeyholder: false,
        isBackgroundCheckReviewer: false,
        isOperations: false,
        isInventoryManager: false,
    };
    return { type: 'session', user };
}

function view(role: Role): readonly Token[] {
    const entry = getRoute(PROGRAM)?.orderedView.find(([r]) => r === role);
    if (!entry) throw new Error(`no ${role} view`);
    return entry[1];
}

function strip(role: Role) {
    const tokens = view(role);
    const bag = {
        Program: {
            id: 3,
            name: 'Robotics',
            participants: [{ personId: 7, programId: 3 }],
            volunteers: [{ personId: 8, programId: 3 }],
            _count: { participants: 1, volunteers: 1 },
        },
        ProgramRosterAge: [{ personId: 7 }],
    };
    return stripBag(bag, tokens, ctx(), hiddenRosterModels(getRoute(PROGRAM)!, tokens));
}

describe('roster token grammar', () => {
    it('parses as a flat token that grants no field', () => {
        expect(parseToken('roster')).toBe('roster');
        expect(fieldVisible('public', ['roster'], new Set(['everyones']))).toBe(false);
        expect(fieldVisible('pii', ['roster'], new Set(['everyones']))).toBe(false);
    });

    it('comes with rosterModels, both ways round', () => {
        expect(rosterDeclarationError({ orderedView: [['anyone', ['roster']]] })).toMatch(/no rosterModels/);
        expect(rosterDeclarationError({ orderedView: [['anyone', ['public']]], rosterModels: ['ProgramParticipant'] }))
            .toMatch(/no view holds/);
        expect(rosterDeclarationError({ orderedView: [['anyone', ['public', 'roster']]], rosterModels: ['ProgramParticipant'] }))
            .toBeNull();
        expect(() => defineRoute({
            endpoint: 'GET /api/__roster-test/no-models',
            authorize: 'public',
            envelope: null,
            orderedView: [['anyone', ['public', 'roster']]],
        })).toThrow(/no rosterModels/);
    });

    it('is refused on a file route', () => {
        expect(() => defineFileRoute({
            endpoint: 'GET /api/__roster-test/file',
            authorize: 'authenticated',
            orderedView: [['authenticated', ['their_own:pii', 'roster']]],
            file: { model: 'Person', field: 'email' },
        })).toThrow(/roster/);
    });
});

describe('GET /api/programs/[id] roster', () => {
    it.each<Role>(['isSysadmin', 'isBoardMember', 'isFinance', 'programLeadMentor', 'programCoreVolunteer', 'programEnrolledHousehold'])(
        '%s receives the roster rows',
        role => {
            const out = strip(role) as { Program: Record<string, unknown>; ProgramRosterAge: unknown[] };
            expect(out.Program.participants).toEqual([{ personId: 7, programId: 3 }]);
            expect(out.Program.volunteers).toEqual([{ personId: 8, programId: 3 }]);
            expect(out.ProgramRosterAge).toHaveLength(1);
        },
    );

    it.each<Role>(['authenticated', 'anyone'])('%s gets the program and its counts, no roster rows', role => {
        const out = strip(role) as { Program: Record<string, unknown>; ProgramRosterAge: unknown[] };
        expect(out.Program).not.toHaveProperty('participants');
        expect(out.Program).not.toHaveProperty('volunteers');
        expect(out.Program.name).toBe('Robotics');
        expect(out.Program._count).toEqual({ participants: 1, volunteers: 1 });
        expect(out.ProgramRosterAge).toEqual([]);
    });

    it('the enrolled-household view sits above authenticated, and grants what authenticated does', () => {
        const roles = getRoute(PROGRAM)!.orderedView.map(([r]) => r);
        expect(roles.indexOf('programEnrolledHousehold')).toBe(roles.indexOf('authenticated') - 1);
        expect(view('programEnrolledHousehold').filter(t => t !== 'roster')).toEqual(view('authenticated'));
    });
});

describe('programEnrolledHousehold role', () => {
    const enrolled = ctx({ programsEnrolledIn: new Set([3]) });

    it('holds for a session enrolled in params.id', () => {
        expect(callerHoldsRole('programEnrolledHousehold', session(1), { id: '3' }, enrolled)).toBe(true);
    });

    it('does not hold for another program, a missing id, an unfetched set, or a non-session', () => {
        expect(callerHoldsRole('programEnrolledHousehold', session(1), { id: '4' }, enrolled)).toBe(false);
        expect(callerHoldsRole('programEnrolledHousehold', session(1), {}, enrolled)).toBe(false);
        expect(callerHoldsRole('programEnrolledHousehold', session(1), { id: '3' }, ctx())).toBe(false);
        expect(callerHoldsRole('programEnrolledHousehold', { type: 'kiosk' }, { id: '3' }, enrolled)).toBe(false);
        expect(callerHoldsRole('programEnrolledHousehold', { type: 'unauthenticated' }, { id: '3' }, enrolled)).toBe(false);
    });
});
