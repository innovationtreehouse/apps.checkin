/**
 * @jest-environment node
 *
 * A relation whose target model shows the caller no field is omitted, so the
 * wire never carries a bare `{}` or `[{}, {}]` that reveals a row count.
 */
import { stripValue } from '@/security/stripper';
import { outboundCall } from '@/security/outbound';
import type { CallerContext } from '@/security/access-resolvers';
import type { Token } from '@/security/core';

function ctx(): CallerContext {
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
    };
}

const visit = { id: 1, personId: 7, facilityClose: { id: 3, via: 'KEYHOLDER' } };

describe('stripper — a relation the view cannot see', () => {
    it('omits a single relation whose target has no field in the view', () => {
        expect(stripValue('Visit', visit, ['public'] as Token[], ctx())).toEqual({ id: 1, personId: 7 });
    });

    it('omits a list relation instead of sending one empty row per child', () => {
        const person = { sessions: [{ id: 's1', sessionToken: 'x' }, { id: 's2', sessionToken: 'y' }] };
        expect(stripValue('Person', person, ['public'] as Token[], ctx())).toEqual({});
    });

    it('keeps the relation once the view sees a field on its target', () => {
        expect(stripValue('Visit', visit, ['public', 'everyones:internal'] as Token[], ctx())).toEqual({
            id: 1,
            personId: 7,
            facilityClose: { id: 3, via: 'KEYHOLDER' },
        });
    });
});

describe('stripper — related rows outside the caller\'s scope', () => {
    const line = { id: 1, reimburseePersonId: 9, lineNumber: 1, description: 'Arduino' };
    const own = ['their_own:internal'] as Token[];

    it('drops the rows the caller sees no field of and keeps the rest', () => {
        const receipt = { lineItems: [line, { ...line, id: 2, reimburseePersonId: 7 }] };
        expect(stripValue('ReceiptConfirmationView', receipt, own, { ...ctx(), selfId: 9 })).toEqual({
            lineItems: [line],
        });
    });

    it('sends an empty list when the caller sees no related row', () => {
        expect(stripValue('ReceiptConfirmationView', { lineItems: [line] }, own, { ...ctx(), selfId: 7 })).toEqual({
            lineItems: [],
        });
    });
});

describe('outbound — a relation the surface cannot send', () => {
    const sent = (surface: string) =>
        outboundCall(surface, { Visit: visit }, async stripped => stripped);

    it('omits a relation whose target has no field in the surface tiers', async () => {
        await expect(sent('quickbooks.query')).resolves.toEqual({ Visit: { id: 1, personId: 7 } });
    });

    it('keeps the relation when the surface sends a tier on its target', async () => {
        await expect(sent('quickbooks.create')).resolves.toEqual({ Visit: visit });
    });
});
