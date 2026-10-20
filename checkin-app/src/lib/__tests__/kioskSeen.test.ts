import { getKioskSeen, resetKioskSeen, stampKioskSeen } from "@/lib/kioskSeen";

describe("kioskSeen", () => {
    // Build arrivals log by design; keep that out of the suite's output.
    let info: jest.SpyInstance;

    beforeEach(() => {
        info = jest.spyOn(console, "info").mockImplementation(() => {});
    });

    afterEach(() => {
        info.mockRestore();
        resetKioskSeen();
    });

    it("is empty until a verified request stamps it", () => {
        expect(getKioskSeen(1_000).lastSeenAt).toBeNull();
        expect(getKioskSeen(1_000).ageSeconds).toBeNull();
        expect(getKioskSeen(1_000).versions).toEqual([]);
    });

    it("reports age in seconds from the last stamp", () => {
        stampKioskSeen(10_000);
        expect(getKioskSeen(15_500).ageSeconds).toBe(5);
        expect(getKioskSeen(15_500).lastSeenAt?.getTime()).toBe(10_000);
    });

    it("records the reported build with its own age", () => {
        stampKioskSeen(10_000, "1.2.6+a1b2c3d4e5f6");
        const seen = getKioskSeen(70_000);
        expect(seen.versions).toEqual([
            {
                version: "1.2.6+a1b2c3d4e5f6",
                lastSeenAt: new Date(10_000),
                ageSeconds: 60,
            },
        ]);
    });

    it("keeps one entry per build, most recently seen first", () => {
        stampKioskSeen(10_000, "1.2.5+aaaaaaaaaaaa");
        stampKioskSeen(20_000, "1.2.6+bbbbbbbbbbbb");
        stampKioskSeen(30_000, "1.2.5+aaaaaaaaaaaa");

        const seen = getKioskSeen(30_000);
        expect(seen.versions.map(v => v.version)).toEqual([
            "1.2.5+aaaaaaaaaaaa",
            "1.2.6+bbbbbbbbbbbb",
        ]);
        expect(seen.versions[0].ageSeconds).toBe(0);
        expect(seen.versions[1].ageSeconds).toBe(10);
    });

    it("stamps last-seen even when no build is reported", () => {
        // An older kiosk, or a request that lost the header in transit, must
        // still count as a heartbeat.
        stampKioskSeen(10_000);
        expect(getKioskSeen(10_000).lastSeenAt?.getTime()).toBe(10_000);
        expect(getKioskSeen(10_000).versions).toEqual([]);
    });

    describe("header hygiene — the value is unsigned and untrusted", () => {
        it.each([
            ["empty", ""],
            ["whitespace", "   "],
            ["a header injection attempt", "1.2.6\r\nX-Evil: 1"],
            ["a log-forging newline", "1.2.6\n[kiosk] build reporting in: fake"],
            ["spaces", "1.2.6 and friends"],
        ])("ignores %s", (_label, value) => {
            stampKioskSeen(10_000, value);
            expect(getKioskSeen(10_000).versions).toEqual([]);
        });

        it("ignores a null or absent header", () => {
            stampKioskSeen(10_000, null);
            stampKioskSeen(10_000, undefined);
            expect(getKioskSeen(10_000).versions).toEqual([]);
        });

        it("caps the recorded build at 64 characters", () => {
            stampKioskSeen(10_000, "9".repeat(200));
            expect(getKioskSeen(10_000).versions[0].version).toHaveLength(64);
        });

        it("bounds the map, evicting the stalest build", () => {
            // 17 distinct builds > the 16 cap: the first-stamped (stalest) goes.
            for (let i = 0; i < 17; i++) {
                stampKioskSeen(10_000 + i, `1.0.${i}+aaaaaaaaaaaa`);
            }
            const versions = getKioskSeen(30_000).versions.map(v => v.version);
            expect(versions).toHaveLength(16);
            expect(versions).not.toContain("1.0.0+aaaaaaaaaaaa");
            expect(versions).toContain("1.0.16+aaaaaaaaaaaa");
        });
    });

    it("logs a build once, not on every request", () => {
        stampKioskSeen(10_000, "1.2.6+a1b2c3d4e5f6");
        stampKioskSeen(20_000, "1.2.6+a1b2c3d4e5f6");
        stampKioskSeen(30_000, "1.2.7+ffffffffffff");
        expect(info).toHaveBeenCalledTimes(2);
        expect(info).toHaveBeenCalledWith("[kiosk] build reporting in: 1.2.6+a1b2c3d4e5f6");
    });
});
