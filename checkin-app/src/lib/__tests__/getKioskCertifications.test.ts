const visitFindMany = jest.fn();
const personFindMany = jest.fn();
const toolFindMany = jest.fn();
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        visit: { findMany: (...a: unknown[]) => visitFindMany(...a) },
        person: { findMany: (...a: unknown[]) => personFindMany(...a) },
        tool: { findMany: (...a: unknown[]) => toolFindMany(...a) },
    },
}));

import { getKioskCertifications, invalidateKioskCertificationsCache } from "@/lib/getKioskCertifications";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";

const people = [
    {
        id: 1,
        email: "alex@example.com",
        name: "Alex Smith",
        nickname: "Al",
        toolStatuses: [{ toolId: 9, level: "CERTIFIED" }],
    },
];
const tools = [{ id: 9, name: "Laser" }];

beforeEach(() => {
    invalidateKioskCertificationsCache();
    visitFindMany.mockReset();
    personFindMany.mockReset();
    toolFindMany.mockReset();
    visitFindMany.mockResolvedValue([{ person: people[0] }]);
    personFindMany.mockResolvedValue(people);
    toolFindMany.mockResolvedValue(tools);
});

describe("getKioskCertifications", () => {
    it("strips the raw email and caches the present-limited payload", async () => {
        const first = await getKioskCertifications({ limitToPresent: true });
        await getKioskCertifications({ limitToPresent: true });

        expect(first.participants).toEqual([
            { id: 1, name: "Alex Smith", nickname: "Al", toolStatuses: [{ toolId: 9, level: "CERTIFIED" }] },
        ]);
        expect(JSON.stringify(first)).not.toContain("@example.com");
        expect(visitFindMany).toHaveBeenCalledTimes(1);
        expect(toolFindMany).toHaveBeenCalledTimes(1);
        expect(personFindMany).not.toHaveBeenCalled();
    });

    it("caches the all-members shape separately", async () => {
        await getKioskCertifications({ limitToPresent: true });
        await getKioskCertifications({ limitToPresent: false });
        await getKioskCertifications({ limitToPresent: false });

        expect(visitFindMany).toHaveBeenCalledTimes(1);
        expect(personFindMany).toHaveBeenCalledTimes(1);
        expect(toolFindMany).toHaveBeenCalledTimes(2);
    });

    it("a visit-cache invalidate also drops the certs cache (present grid is occupancy)", async () => {
        await getKioskCertifications({ limitToPresent: true });
        invalidateAttendanceCache();
        await getKioskCertifications({ limitToPresent: true });
        expect(visitFindMany).toHaveBeenCalledTimes(2);
    });
});
