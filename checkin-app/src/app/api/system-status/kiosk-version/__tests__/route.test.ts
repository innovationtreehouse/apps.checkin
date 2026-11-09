/**
 * @jest-environment node
 */
import { SCAN_PROTOCOL_VERSION } from '@/lib/scanProtocol';

async function getWithSha(sha: string | undefined) {
    const original = process.env.NEXT_PUBLIC_GIT_SHA;
    if (sha === undefined) delete process.env.NEXT_PUBLIC_GIT_SHA;
    else process.env.NEXT_PUBLIC_GIT_SHA = sha;
    try {
        // The route reads the variable at module load.
        jest.resetModules();
        const { GET } = await import('../route');
        const res = await GET();
        expect(res.status).toBe(200);
        return await res.json();
    } finally {
        if (original === undefined) delete process.env.NEXT_PUBLIC_GIT_SHA;
        else process.env.NEXT_PUBLIC_GIT_SHA = original;
    }
}

describe('GET /api/system-status/kiosk-version', () => {
    it('advertises the build SHA and the scan protocol generation', async () => {
        const body = await getWithSha('abc123');
        expect(body.version).toBe('abc123');
        // The contract bit the kiosk gates replay behavior on.
        expect(body.scanProtocolVersion).toBe(SCAN_PROTOCOL_VERSION);
    });

    it('reports a stable "dev" when the build has no SHA', async () => {
        const first = await getWithSha(undefined);
        const second = await getWithSha(undefined);
        expect(first.version).toBe('dev');
        expect(second.version).toBe('dev');
    });
});
