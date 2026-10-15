// Request body size limits for /api, enforced by the middleware before a route reads the body.
// Kept free of runtime imports: next.config.ts reads MAX_UPLOAD_BODY_BYTES.

export const MAX_JSON_BODY_BYTES = 1024 * 1024;

/**
 * A 10 MB file plus multipart framing. Also next.config's proxyClientMaxBodySize, the most of a
 * body Next buffers for the middleware and the route.
 */
export const MAX_UPLOAD_BODY_BYTES = 11 * 1024 * 1024;

/** API routes that accept a file upload. Each route still enforces its own exact file cap. */
export const UPLOAD_ROUTES: readonly string[] = [
    '/api/donations/uploaded-files',
    '/api/membership-ops/participants/import',
    '/api/membership-ops/participants/import/preview',
    '/api/receipts/upload',
    '/api/receipts/import',
];

export function bodyLimitFor(pathname: string): number {
    return UPLOAD_ROUTES.includes(pathname) ? MAX_UPLOAD_BODY_BYTES : MAX_JSON_BODY_BYTES;
}

/** True when the declared Content-Length exceeds the route's limit. An absent header is not checked here. */
export function isDeclaredBodyTooLarge(pathname: string, contentLength: string | null): boolean {
    if (contentLength === null) return false;
    return !(Number(contentLength) <= bodyLimitFor(pathname));
}

/** True when a body sent without Content-Length runs past the route's limit. Stops reading once it does. */
export async function isStreamedBodyTooLarge(pathname: string, body: ReadableStream<Uint8Array>): Promise<boolean> {
    const limit = bodyLimitFor(pathname);
    const reader = body.getReader();
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) return false;
        total += value.byteLength;
        if (total > limit) {
            await reader.cancel();
            return true;
        }
    }
}
