/**
 * @jest-environment node
 */
/**
 * EmergencyContact visibility on GET /api/programs/[id].
 *
 * Two coupled guards:
 *   1. ROW_SCOPE_KEY fail-closed: an EmergencyContact row missing its
 *      `householdId` scope key resolves to NO scopes (not even everyones), so
 *      personal fields (name/phone/relationship) strip for EVERY viewer,
 *      admin/board included. The route select must ship householdId or the whole
 *      emergency-contacts block silently renders as `undefined`.
 *   2. their_program_households binding: once householdId ships, a program lead /
 *      core-vol overseeing the child's household (ctx.householdIdsInScopePrograms)
 *      holds their_program_households on the row, and the registry grants that
 *      view their_program_households:personal — so leads see name/phone. A plain
 *      authenticated user in an unrelated household does not. Mirrors TrustedAdult.
 * Pulls live view tokens from the registry so this tracks future policy edits.
 */
import { stripValue } from '@/security/stripper';
import { scopesHeld, type CallerContext } from '@/security/access-resolvers';
import { getRoute, type Role, type Token } from '@/security/core';
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

// The EC row as the route now ships it (householdId included, #fix).
const ecRow = { id: 7, householdId: 42, name: 'Jane Doe', phone: '5551234567', relationship: 'Aunt' };
// Lead of a program that a child of household 42 is enrolled in.
const lead = ctx({ selfId: 10, programsLed: new Set([100]), householdIdsInScopePrograms: new Set([42]) });
const coreVol = ctx({ selfId: 11, programsCoreVolIn: new Set([101]), householdIdsInScopePrograms: new Set([42]) });
// Parent of household 42 (own household).
const parent = ctx({ selfId: 12, householdId: 42 });
// Unrelated authenticated caller — no programs, different household.
const outsider = ctx({ selfId: 99, householdId: 999 });

describe('EmergencyContact scope resolution', () => {
    it('fails CLOSED when the row is missing its householdId scope key', () => {
        const held = scopesHeld('EmergencyContact', { id: 7, name: 'x', phone: 'y' }, lead);
        expect(held.size).toBe(0); // not even everyones
    });

    it('grants their_program_households to a lead overseeing the household', () => {
        const held = scopesHeld('EmergencyContact', ecRow, lead);
        expect(held.has('their_program_households')).toBe(true);
    });

    it('grants their_program_households to a core-vol overseeing the household', () => {
        expect(scopesHeld('EmergencyContact', ecRow, coreVol).has('their_program_households')).toBe(true);
    });

    it('grants their_households to the household parent', () => {
        expect(scopesHeld('EmergencyContact', ecRow, parent).has('their_households')).toBe(true);
    });

    it('grants an unrelated caller only everyones', () => {
        const held = scopesHeld('EmergencyContact', ecRow, outsider);
        expect(held.has('their_program_households')).toBe(false);
        expect(held.has('their_households')).toBe(false);
        expect([...held]).toEqual(['everyones']);
    });
});

describe('EmergencyContact field-stripping on GET /api/programs/[id]', () => {
    it('a program lead sees name/phone/relationship', () => {
        const tokens = tokensFor(ENDPOINT, 'programLeadMentor');
        const out = stripValue('EmergencyContact', ecRow, tokens, lead) as Record<string, unknown>;
        expect(out.name).toBe('Jane Doe');
        expect(out.phone).toBe('5551234567');
        expect(out.relationship).toBe('Aunt');
    });

    it('board sees name/phone via everyones:personal', () => {
        const tokens = tokensFor(ENDPOINT, 'isBoardMember');
        const out = stripValue('EmergencyContact', ecRow, tokens, ctx()) as Record<string, unknown>;
        expect(out.name).toBe('Jane Doe');
        expect(out.phone).toBe('5551234567');
    });

    it('an unrelated authenticated caller gets id only, personal fields stripped', () => {
        const tokens = tokensFor(ENDPOINT, 'authenticated');
        const out = stripValue('EmergencyContact', ecRow, tokens, outsider) as Record<string, unknown>;
        expect(out.id).toBe(7); // public tier survives
        expect(out.name).toBeUndefined();
        expect(out.phone).toBeUndefined();
        expect(out.relationship).toBeUndefined();
    });

    it('regression: a lead viewing a row that dropped householdId sees nothing personal', () => {
        // The pre-fix bug — fail-closed strips even for an authorized lead.
        const tokens = tokensFor(ENDPOINT, 'programLeadMentor');
        const noKey = { id: 7, name: 'Jane Doe', phone: '5551234567', relationship: 'Aunt' };
        const out = stripValue('EmergencyContact', noKey, tokens, lead) as Record<string, unknown>;
        expect(out.name).toBeUndefined();
        expect(out.phone).toBeUndefined();
    });
});
