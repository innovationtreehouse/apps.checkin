/**
 * @jest-environment node
 */
import { GET } from '../route';
import { SCAN_PROTOCOL_VERSION } from '@/lib/scanProtocol';

describe('GET /api/system-status/kiosk-version', () => {
    it('advertises the deploy version and the scan protocol generation', async () => {
        const res = await GET();
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(typeof body.version).toBe('string');
        expect(body.version.length).toBeGreaterThan(0);
        // The contract bit the kiosk gates replay behavior on (#1347 §2).
        expect(body.scanProtocolVersion).toBe(SCAN_PROTOCOL_VERSION);
    });
});
