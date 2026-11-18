/**
 * @jest-environment node
 */
/**
 * A roster person's age on GET /api/programs/[id] reaches exactly the viewers
 * who see their date of birth: sysadmin and Board on every row, a program's lead
 * and core volunteers on their participants' rows, and the person on their own.
 * A family member or anyone else keeps the personId alone.
 */
import { stripValue } from '@/security/stripper';
import type { CallerContext } from '@/security/access-resolvers';
import { getRoute, type Role, type Token } from '@/security/core';
import '@/security/registry';

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

function view(role: Role): readonly Token[] {
    const entry = getRoute('GET /api/programs/[id]')?.orderedView.find(([r]) => r === role);
    if (!entry) throw new Error(`no ${role} view`);
    return entry[1];
}

const CHILD = 7;
const row = { personId: CHILD, age: 11 };
const strip = (role: Role, caller: CallerContext) => stripValue('ProgramRosterAge', row, view(role), caller);
const dob = (role: Role, caller: CallerContext) =>
    'dateOfBirth' in (stripValue('Person', { id: CHILD, dateOfBirth: '2015-03-01' }, view(role), caller) as object);

describe('ProgramRosterAge on GET /api/programs/[id]', () => {
    it('is declared in the route returns', () => {
        expect(getRoute('GET /api/programs/[id]')?.returns).toContain('ProgramRosterAge');
    });

    it.each<Role>(['isSysadmin', 'isBoardMember'])('%s sees every age', role => {
        expect(strip(role, ctx())).toEqual(row);
        expect(dob(role, ctx())).toBe(true);
    });

    it.each<Role>(['programLeadMentor', 'programCoreVolunteer'])("%s sees their participant's age", role => {
        const staff = ctx({ participantIdsInScopePrograms: new Set([CHILD]) });
        expect(strip(role, staff)).toEqual(row);
        expect(dob(role, staff)).toBe(true);
    });

    it.each<Role>(['programLeadMentor', 'programCoreVolunteer'])('%s sees no age outside their programs', role => {
        const staff = ctx({ participantIdsInScopePrograms: new Set([99]) });
        expect(strip(role, staff)).toEqual({ personId: CHILD });
        expect(dob(role, staff)).toBe(false);
    });

    it('the person sees their own age', () => {
        expect(strip('authenticated', ctx({ selfId: CHILD }))).toEqual(row);
    });

    it("a member of the child's household sees no age", () => {
        const parent = ctx({ selfId: 2, ledHouseholdMemberIds: new Set([2, CHILD]) });
        expect(strip('authenticated', parent)).toEqual({ personId: CHILD });
        expect(dob('authenticated', parent)).toBe(false);
    });

    it('an ordinary member and an anonymous caller see no age', () => {
        expect(strip('authenticated', ctx())).toEqual({ personId: CHILD });
        expect(strip('anyone', ctx({ selfId: undefined, householdId: undefined }))).toEqual({ personId: CHILD });
    });

    it('a row without personId keeps no age for program staff', () => {
        const staff = ctx({ participantIdsInScopePrograms: new Set([CHILD]) });
        expect(stripValue('ProgramRosterAge', { age: 11 }, view('programLeadMentor'), staff)).toEqual({});
    });

    it('drops any undeclared field, a date of birth included', () => {
        expect(stripValue('ProgramRosterAge', { ...row, dateOfBirth: '2015-03-01' }, view('isSysadmin'), ctx())).toEqual(row);
    });
});
