/**
 * The Shopify write surfaces' tier lists: what each one lets leave from a
 * Program/Household bag.
 */
import { outboundCall, type OutboundPayload } from '@/security/outbound';
import { getOutbound } from '@/security/core';

function capture(surface: string, payload: OutboundPayload): Promise<OutboundPayload> {
    return outboundCall(surface, payload, async stripped => stripped);
}

const PROGRAM = {
    id: 7,                                          // public
    name: 'Robotics',                               // public
    nonOrgMemberPriceCents: 12500,                  // public
    maxParticipants: 10,                            // public
    shopifyProductId: '111',                        // public
    shopifyVariantId: '222',                        // public
    shopifyStockCarry: 3,                           // internal
    shopifyStockPendingWrite: '{"key":"k"}',        // internal
    leadMentorNotificationSettings: { email: true }, // personal
};
const HOUSEHOLD = { id: 9, name: 'Doe', line1: '1 Main St', intakeNotes: 'note' };

describe('Shopify write surfaces', () => {
    it.each(['shopify.product.create', 'shopify.product.update', 'shopify.inventory.activate', 'shopify.discount.create'])(
        '%s lets only public fields leave',
        async (surface) => {
            expect(getOutbound(surface)?.tiers).toEqual(['public']);
            const out = (await capture(surface, { Program: PROGRAM, Household: HOUSEHOLD })) as Record<string, Record<string, unknown>>;
            expect(out.Program).toEqual({ id: 7, name: 'Robotics', nonOrgMemberPriceCents: 12500, maxParticipants: 10, shopifyProductId: '111', shopifyVariantId: '222' });
            expect(out.Household).toEqual({ id: 9, name: 'Doe' });
        },
    );

    it('shopify.inventory.adjust also lets internal stock bookkeeping leave, never personal or pii', async () => {
        expect(getOutbound('shopify.inventory.adjust')?.tiers).toEqual(['public', 'internal']);
        const out = (await capture('shopify.inventory.adjust', { Program: PROGRAM, Household: HOUSEHOLD })) as Record<string, Record<string, unknown>>;
        expect(out.Program.shopifyStockPendingWrite).toBe('{"key":"k"}');
        expect(out.Program.shopifyStockCarry).toBe(3);
        expect(out.Program.leadMentorNotificationSettings).toBeUndefined();
        expect(out.Household).toEqual({ id: 9, name: 'Doe', line1: '1 Main St' });
    });
});
