/**
 * @jest-environment node
 *
 * Registry shape for the facility visit log: who is admitted and which models
 * the response may carry, including the close that ended a visit.
 */
import { getRoute } from '@/security/core';
import '@/security/registry';

describe('facility visits registry', () => {
    it('admits sysadmin and board, and returns the close with its closer', () => {
        const route = getRoute('GET /api/facility/visits');
        expect(route?.authorize).toEqual({ anyRole: ['isSysadmin', 'isBoardMember'] });
        expect(route?.envelope).toBe('visits');
        expect(route?.returns).toEqual(['Visit', 'Person', 'FacilityClose']);
        expect(route?.orderedView.map(([role]) => role)).toEqual(['isSysadmin', 'isBoardMember']);
        for (const [, tokens] of route?.orderedView ?? []) {
            expect(tokens).toContain('everyones:internal');
        }
    });
});
