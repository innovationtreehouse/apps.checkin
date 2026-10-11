import { buildingLink, getKioskSeen, KIOSK_FRESH_MS, resetKioskSeen, stampKioskSeen } from "@/lib/kioskSeen";

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
        expect(buildingLink(1_000)).toEqual({ reachable: false, lastSeenAt: null });
    });

    it("is reachable within the freshness window and not after it", () => {
        stampKioskSeen(10_000);
        expect(buildingLink(10_000 + KIOSK_FRESH_MS).reachable).toBe(true);
        expect(buildingLink(10_001 + KIOSK_FRESH_MS)).toEqual({
            reachable: false,
            lastSeenAt: new Date(10_000).toISOString(),
        });
    });
});
