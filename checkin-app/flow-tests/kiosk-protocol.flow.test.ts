/**
 * @jest-environment node
 */
/**
 * Flow test: the public version route is where a kiosk with no usable clock gets
 * its first server-time sample, from the HTTP Date header.
 */

import { BASE } from "./helpers";

describe("flow: kiosk protocol", () => {
    it("advertises the protocol with a current Date header, unsigned", async () => {
        const res = await fetch(`${BASE}/api/system-status/kiosk-version`);
        expect(res.status).toBe(200);
        expect((await res.json()).scanProtocolVersion).toBeGreaterThanOrEqual(8);
        const serverTime = Date.parse(res.headers.get("date") ?? "");
        expect(Math.abs(Date.now() - serverTime)).toBeLessThan(60_000);
    });
});
