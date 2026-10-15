/**
 * @jest-environment node
 */
import {
    MAX_JSON_BODY_BYTES,
    MAX_UPLOAD_BODY_BYTES,
    UPLOAD_ROUTES,
    bodyLimitFor,
    isDeclaredBodyTooLarge,
    isStreamedBodyTooLarge,
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

    it('counts a body with no Content-Length against the route limit', async () => {
        const body = (bytes: number) => new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(bytes));
                controller.close();
            },
        });
        expect(await isStreamedBodyTooLarge('/api/scan', body(MAX_JSON_BODY_BYTES))).toBe(false);
        expect(await isStreamedBodyTooLarge('/api/scan', body(MAX_JSON_BODY_BYTES + 1))).toBe(true);
        expect(await isStreamedBodyTooLarge(UPLOAD_ROUTES[0], body(MAX_JSON_BODY_BYTES + 1))).toBe(false);
    });

    it('stops reading a body once it passes the limit', async () => {
        let pulls = 0;
        const endless = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulls += 1;
                controller.enqueue(new Uint8Array(MAX_JSON_BODY_BYTES / 2));
            },
        });
        expect(await isStreamedBodyTooLarge('/api/scan', endless)).toBe(true);
        expect(pulls).toBeLessThanOrEqual(4);
    });

    it('refuses a malformed Content-Length', () => {
        expect(isDeclaredBodyTooLarge('/api/scan', 'abc')).toBe(true);
    });

    it('buffers bodies up to the largest upload when the middleware runs', () => {
        expect(nextConfig.experimental?.proxyClientMaxBodySize).toBe(MAX_UPLOAD_BODY_BYTES);
    });
});
