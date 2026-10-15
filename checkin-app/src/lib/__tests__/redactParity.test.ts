/**
 * @jest-environment node
 */
import { redactSecrets } from '../redact';
// The file itself, not the package barrel: the barrel pulls in the Prisma client.
import { redactSecrets as ingestRedactSecrets } from '../../../../packages/s-ingest-core/src/redact';

const FIXTURE = [
    'GET https://shop.example.com/admin/api/orders.json?access_token=abc123 failed',
    'POST https://shop.example.com/admin/api/graphql.json returned 502',
    'customer jane.doe+x@example.org not found',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
    'Authorization: Zoho-oauthtoken 1000.abcdef.123456',
    'X-Shopify-Access-Token: shpat_0123456789abcdef',
    '{"client_secret":"s3cr3t-value","refresh_token":"1000.rt.xyz"}',
    'api_key=AKIA1234&password=hunter2',
    'stripe key sk_live_0123456789abcdefghij rejected',
    'opaque 0123456789abcdefABCDEF0123456789abcdefAB== in body',
    'long_snake_case_identifier_without_any_digits_at_all stays',
    'plain message with nothing to redact',
].join('\n');

describe('redactSecrets parity', () => {
    it('checkin-app and s-ingest-core redact the same text identically', () => {
        expect(ingestRedactSecrets(FIXTURE)).toBe(redactSecrets(FIXTURE));
    });
});
