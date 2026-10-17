/**
 * @jest-environment node
 */
// View tokens come from the live registry, so these pins track policy edits.
import { stripValue } from '@/security/stripper';
import { type CallerContext } from '@/security/access-resolvers';
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

// A pending row as the roster route ships it (programId is the
// their_program_participants ROW_SCOPE_KEY).
const row = {
    programId: 7,
    personId: 501,
    status: 'PENDING',
    pendingSince: '2026-01-06T00:00:00.000Z',
    wasOrgMemberAtApproval: null,
    inventoryHeldAt: '2026-01-06T00:00:00.000Z',
};

describe('ProgramParticipant.pendingSince field-stripping (#1409)', () => {
    it('lead mentor now sees pendingSince (personal, a band this view holds)', () => {
        const tokens = tokensFor(ENDPOINT, 'programLeadMentor');
        const leadCtx = ctx({ programsLed: new Set([7]) });
        const out = stripValue('ProgramParticipant', row, tokens, leadCtx) as Record<string, unknown>;
        expect(out.pendingSince).toBe('2026-01-06T00:00:00.000Z');
    });

    it('core volunteer also sees pendingSince — same grant on this route', () => {
        const tokens = tokensFor(ENDPOINT, 'programCoreVolunteer');
        const coreCtx = ctx({ programsCoreVolIn: new Set([7]) });
        const out = stripValue('ProgramParticipant', row, tokens, coreCtx) as Record<string, unknown>;
        expect(out.pendingSince).toBe('2026-01-06T00:00:00.000Z');
    });

    it('a band the lead lacks (:internal) still strips — inventoryHeldAt stays hidden', () => {
        const tokens = tokensFor(ENDPOINT, 'programLeadMentor');
        const leadCtx = ctx({ programsLed: new Set([7]) });
        const out = stripValue('ProgramParticipant', row, tokens, leadCtx) as Record<string, unknown>;
        expect(out.inventoryHeldAt).toBeUndefined();
        expect(out.wasOrgMemberAtApproval).toBeUndefined();
    });

    it('a caller with no scope on this row (not the lead of programId 7) sees neither', () => {
        const tokens = tokensFor(ENDPOINT, 'programLeadMentor');
        const outsiderCtx = ctx({ programsLed: new Set([99]) });
        const out = stripValue('ProgramParticipant', row, tokens, outsiderCtx) as Record<string, unknown>;
        expect(out.pendingSince).toBeUndefined();
        expect(out.inventoryHeldAt).toBeUndefined();
    });
});
