/**
 * @jest-environment node
 */
import { redactSecrets } from '../redact';

describe('redactSecrets', () => {
    it('strips URLs with a query string, keeping plain ones', () => {
        expect(redactSecrets('GET https://shop.example.com/admin/api/orders.json?access_token=abc123 failed'))
            .toBe('GET [url] failed');
        expect(redactSecrets('POST https://shop.example.com/admin/api/products.json returned 422'))
            .toBe('POST https://shop.example.com/admin/api/products.json returned 422');
    });

    it('strips email addresses', () => {
        expect(redactSecrets('customer jane.doe+x@example.org not found')).toBe('customer [email] not found');
    });

    it('strips auth headers, key=value secrets and token prefixes', () => {
        expect(redactSecrets('Authorization: Zoho-oauthtoken 1000.abcdef.123456')).toBe('Authorization: [redacted] [redacted]');
        expect(redactSecrets('X-Shopify-Access-Token: shpat_0123456789abcdef')).toBe('X-Shopify-Access-Token: [redacted]');
        expect(redactSecrets('{"client_secret":"s3cr3t","ok":true}')).toBe('{"client_secret":"[redacted]","ok":true}');
        expect(redactSecrets('used key shpat_0123456789abcdef0123')).toBe('used key [redacted]');
        expect(redactSecrets('Bearer eyJhbGciOi.payload.sig')).toBe('Bearer [redacted]');
    });

    it('strips long opaque strings', () => {
        expect(redactSecrets('sig 0123456789abcdef0123456789abcdef01 bad')).toBe('sig [redacted] bad');
    });

    it('leaves ordinary error text alone', () => {
        const msg = 'inventory_levels/set returned 422: {"errors":["Inventory item does not have inventory tracking enabled"]}';
        expect(redactSecrets(msg)).toBe(msg);
        const path = 'PUT https://shop.example.com/admin/api/2024-10/inventory_levels/set.json: inventory_item_id_missing_for_variant';
        expect(redactSecrets(path)).toBe(path);
    });
});
