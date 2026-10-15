import {
    MAX_JSON_BODY_BYTES,
    MAX_UPLOAD_BODY_BYTES,
    UPLOAD_ROUTES,
    bodyLimitFor,
    isDeclaredBodyTooLarge,
} from '@/lib/requestBodyLimit';
import nextConfig from '../../../next.config';

describe('request body limits', () => {
    it('allows a JSON body up to the limit and refuses one byte more', () => {
        expect(isDeclaredBodyTooLarge('/api/scan', String(MAX_JSON_BODY_BYTES))).toBe(false);
        expect(isDeclaredBodyTooLarge('/api/scan', String(MAX_JSON_BODY_BYTES + 1))).toBe(true);
    });

    it('gives every upload route the upload limit, and only the exact path', () => {
        for (const route of UPLOAD_ROUTES) {
            expect(bodyLimitFor(route)).toBe(MAX_UPLOAD_BODY_BYTES);
            expect(bodyLimitFor(`${route}/123`)).toBe(MAX_JSON_BODY_BYTES);
        }
    });

    it('leaves a request with no Content-Length to the proxy body limit', () => {
        expect(isDeclaredBodyTooLarge('/api/scan', null)).toBe(false);
    });

    it('refuses a malformed Content-Length', () => {
        expect(isDeclaredBodyTooLarge('/api/scan', 'abc')).toBe(true);
    });

    it('buffers bodies up to the largest upload when the middleware runs', () => {
        expect(nextConfig.experimental?.proxyClientMaxBodySize).toBe(MAX_UPLOAD_BODY_BYTES);
    });
});
