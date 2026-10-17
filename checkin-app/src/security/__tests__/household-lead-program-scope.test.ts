/**
 * @jest-environment node
 */
/**
 * Parent (household lead) visibility on GET /api/programs/[id].
 *
 * A program lead needs to phone a child's parents, and a parent is not a
 * program participant — so `their_program_participants` never reaches them.
 * Person is bound `their_program_households` on (householdId ∈
 * householdIdsInScopePrograms AND isHouseholdLead), and the registry grants
 * that view their_program_households:pii, so a lead/core-vol sees the parents'
 * name/email/phone.
 *
 * The conjunct is the policy, so both halves are asserted negative: a sibling
 * in the same household (no isHouseholdLead) and a household lead in a family
 * with no child in the program each hold nothing.
 *
 * The same pii token must NOT reach Household.intakeNotes — Household binds no
 * scope but their_households, so it resolves to nothing on a Household row.
 * Pulls live view tokens from the registry so this tracks future policy edits.
 */
import { stripValue } from '@/security/stripper';
import { scopesHeld, type CallerContext } from '@/security/access-resolvers';
import { getRoute, type Role, type Token } from '@/security/core';
import { SCOPE_BINDINGS } from '@/security/scopeBindings';
import '@/security/registry';

function ctx(opts: Partial<CallerContext> = {}): CallerContext {
    return {
        selfId: undefined,
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
        ...opts,
    };
}

function tokensFor(endpoint: string, role: Role): readonly Token[] {
    const spec = getRoute(endpoint);
    if (!spec) throw new Error(`no registry entry for ${endpoint}`);
    const entry = spec.orderedView.find(([r]) => r === role);
    if (!entry) throw new Error(`no orderedView entry for ${role} on ${endpoint}`);
    return entry[1];
}

const ENDPOINT = 'GET /api/programs/[id]';

// A parent of household 42, as the roster route ships them.
const parentRow = {
    id: 500,
    householdId: 42,
    isHouseholdLead: true,
    name: 'Sam Smith',
    email: 'sam@example.com',
    phone: '5125551234',
};
// Same household, not a lead — the enrolled child's sibling.
const siblingRow = { ...parentRow, id: 501, isHouseholdLead: false, name: 'Kai Smith' };
// A lead of a household with no child in this program.
const outsiderParentRow = { ...parentRow, id: 502, householdId: 77, name: 'Rae Jones' };

// Lead of a program that a child of household 42 is enrolled in.
const lead = ctx({ selfId: 10, programsLed: new Set([100]), householdIdsInScopePrograms: new Set([42]) });
const coreVol = ctx({ selfId: 11, programsCoreVolIn: new Set([101]), householdIdsInScopePrograms: new Set([42]) });
// Unrelated authenticated caller — no programs, different household.
const outsider = ctx({ selfId: 99, householdId: 999 });

describe('Person.their_program_households scope resolution', () => {
    it('grants their_program_households on a parent of an in-scope household', () => {
        expect(scopesHeld('Person', parentRow, lead).has('their_program_households')).toBe(true);
        expect(scopesHeld('Person', parentRow, coreVol).has('their_program_households')).toBe(true);
    });

    it('grants nothing on a non-lead member of the same household', () => {
        expect(scopesHeld('Person', siblingRow, lead).has('their_program_households')).toBe(false);
    });

    it('grants nothing on a household lead outside the program', () => {
        expect(scopesHeld('Person', outsiderParentRow, lead).has('their_program_households')).toBe(false);
    });

    it('fails closed when the select omitted isHouseholdLead', () => {
        const noFlag = { id: 500, householdId: 42, name: 'Sam Smith', phone: '5125551234' };
        expect(scopesHeld('Person', noFlag, lead).has('their_program_households')).toBe(false);
    });

    it('fails closed when the select omitted householdId', () => {
        const noHousehold = { id: 500, isHouseholdLead: true, name: 'Sam Smith', phone: '5125551234' };
        expect(scopesHeld('Person', noHousehold, lead).has('their_program_households')).toBe(false);
    });

    it('grants an unrelated caller only everyones', () => {
        expect([...scopesHeld('Person', parentRow, outsider)]).toEqual(['everyones']);
    });
});

describe('Parent field-stripping on GET /api/programs/[id]', () => {
    it('a program lead sees the parent name/email/phone', () => {
        const tokens = tokensFor(ENDPOINT, 'programLeadMentor');
        const out = stripValue('Person', parentRow, tokens, lead) as Record<string, unknown>;
        expect(out.name).toBe('Sam Smith');
        expect(out.email).toBe('sam@example.com');
        expect(out.phone).toBe('5125551234');
    });

    it('a core volunteer sees them too', () => {
        const tokens = tokensFor(ENDPOINT, 'programCoreVolunteer');
        const out = stripValue('Person', parentRow, tokens, coreVol) as Record<string, unknown>;
        expect(out.phone).toBe('5125551234');
    });

    it('a lead sees no contact details for a non-lead household member', () => {
        const tokens = tokensFor(ENDPOINT, 'programLeadMentor');
        const out = stripValue('Person', siblingRow, tokens, lead) as Record<string, unknown>;
        expect(out.name).toBe('Kai Smith'); // public tier survives
        expect(out.email).toBeUndefined();
        expect(out.phone).toBeUndefined();
    });

    it('a lead sees no contact details for a parent outside their programs', () => {
        const tokens = tokensFor(ENDPOINT, 'programLeadMentor');
        const out = stripValue('Person', outsiderParentRow, tokens, lead) as Record<string, unknown>;
        expect(out.email).toBeUndefined();
        expect(out.phone).toBeUndefined();
    });

    it('an unrelated authenticated caller sees no contact details', () => {
        const tokens = tokensFor(ENDPOINT, 'authenticated');
        const out = stripValue('Person', parentRow, tokens, outsider) as Record<string, unknown>;
        expect(out.id).toBe(500);
        expect(out.email).toBeUndefined();
        expect(out.phone).toBeUndefined();
    });

    it('the Household model stays bound to their_households only', () => {
        // The intakeNotes GUARD in schema.prisma rests on this: a program- or
        // keyholder-scoped token must never resolve on a Household row.
        expect(Object.keys(SCOPE_BINDINGS.Household)).toEqual(['their_households']);
    });

    it('the pii grant does NOT reach Household.intakeNotes or the address', () => {
        const tokens = tokensFor(ENDPOINT, 'programLeadMentor');
        const household = { id: 42, name: 'Smith', intakeNotes: 'please call mom first', line1: '1 Main St', city: 'Austin' };
        const out = stripValue('Household', household, tokens, lead) as Record<string, unknown>;
        expect(out.name).toBe('Smith');
        expect(out.intakeNotes).toBeUndefined();
        expect(out.line1).toBeUndefined();
        expect(out.city).toBeUndefined();
    });
});

// The route ships `volunteers: { include: { person: true } }` and `leadMentor: true`
// — full-row Person selects outside the participant bag. A volunteer who is also a
// household lead of an in-scope household (a parent volunteer) therefore resolves the
// new binding on merge, with no follow-up. These pin what that delivers.
describe('Parent volunteers, the shape the route already returns', () => {
    const parentVolunteerRow = {
        programId: 100,
        personId: 500,
        isCore: false,
        person: {
            ...parentRow,
            dateOfBirth: new Date('1985-04-02'),
            allergies: 'penicillin',
            emailSuppressed: false,
        },
    };

    it('delivers the parent volunteer contact details to a lead', () => {
        const tokens = tokensFor(ENDPOINT, 'programLeadMentor');
        const out = stripValue('ProgramVolunteer', parentVolunteerRow, tokens, lead) as {
            person: Record<string, unknown>;
        };
        expect(out.person.email).toBe('sam@example.com');
        expect(out.person.phone).toBe('5125551234');
    });

    it('also delivers their personal tier — the collateral of reusing the scope', () => {
        // their_program_households:personal is pre-existing on this view; binding
        // Person to the scope is what makes it resolve here. Narrowing the route's
        // select is what takes these back off the wire.
        const tokens = tokensFor(ENDPOINT, 'programLeadMentor');
        const out = stripValue('ProgramVolunteer', parentVolunteerRow, tokens, lead) as {
            person: Record<string, unknown>;
        };
        expect(out.person.dateOfBirth).toEqual(new Date('1985-04-02'));
        expect(out.person.allergies).toBe('penicillin');
        expect(out.person.emailSuppressed).toBe(false);
    });

    it('a volunteer who is not a household lead keeps public tier only', () => {
        const tokens = tokensFor(ENDPOINT, 'programLeadMentor');
        const row = {
            ...parentVolunteerRow,
            person: { ...parentVolunteerRow.person, isHouseholdLead: false },
        };
        const out = stripValue('ProgramVolunteer', row, tokens, lead) as {
            person: Record<string, unknown>;
        };
        expect(out.person.name).toBe('Sam Smith');
        expect(out.person.email).toBeUndefined();
        expect(out.person.allergies).toBeUndefined();
    });
});
