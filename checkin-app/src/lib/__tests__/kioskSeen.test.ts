import { buildingLink, getKioskSeen, KIOSK_FRESH_MS, parseQueueDepth, resetKioskSeen, stampKioskSeen } from "@/lib/kioskSeen";

describe("kioskSeen", () => {
    afterEach(() => resetKioskSeen());

    it("is empty until a verified request stamps it", () => {
        expect(getKioskSeen(1_000).lastSeenAt).toBeNull();
        expect(getKioskSeen(1_000).ageSeconds).toBeNull();
    });

    it("reports age in seconds from the last stamp", () => {
        stampKioskSeen(10_000);
        expect(getKioskSeen(15_500).ageSeconds).toBe(5);
        expect(getKioskSeen(15_500).lastSeenAt?.getTime()).toBe(10_000);
    });
});

describe("buildingLink", () => {
    afterEach(() => resetKioskSeen());

    it("is unreachable before any kiosk request", () => {
        expect(buildingLink(1_000)).toEqual({ reachable: false, lastSeenAt: null, queued: 0 });
    });

    it("is reachable within the freshness window and not after it", () => {
        stampKioskSeen(10_000);
        expect(buildingLink(10_000 + KIOSK_FRESH_MS).reachable).toBe(true);
        expect(buildingLink(10_001 + KIOSK_FRESH_MS)).toEqual({
            reachable: false,
            lastSeenAt: new Date(10_000).toISOString(),
            queued: 0,
        });
    });

    it("is not reachable while the kiosk has scans queued, and counts them", () => {
        stampKioskSeen(10_000, 3);
        expect(buildingLink(10_000)).toMatchObject({ reachable: false, queued: 3 });
    });

    it("clears the backlog on the next report that the queue is empty", () => {
        stampKioskSeen(10_000, 3);
        stampKioskSeen(20_000, 0);
        expect(buildingLink(20_000)).toMatchObject({ reachable: true, queued: 0 });
    });

    it("a stale heartbeat reports no backlog: can't confirm wins over syncing", () => {
        stampKioskSeen(10_000, 3);
        expect(buildingLink(10_001 + KIOSK_FRESH_MS)).toMatchObject({ reachable: false, queued: 0 });
    });
});

describe("parseQueueDepth", () => {
    it.each([
        ["7", 7], ["0", 0], [null, 0], [undefined, 0], ["", 0], ["-1", 0], ["1.5", 0], ["abc", 0], ["99999999999999999999", 0],
    ])("reads %s as %d", (header, depth) => {
        expect(parseQueueDepth(header)).toBe(depth);
    });
});
