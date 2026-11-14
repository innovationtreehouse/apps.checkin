import prisma from "@/lib/prisma";
import { variantYearsUnset } from "@/lib/nav/todoCounts";

jest.mock("@/lib/prisma", () => ({ __esModule: true, default: { membershipYearVariant: { findMany: jest.fn() } } }));

const findMany = prisma.membershipYearVariant.findMany as jest.Mock;
const boundary = new Date("2000-09-01T00:00:00.000Z");
const offSeason = new Date("2026-11-01T00:00:00.000Z");
const inWindow = new Date("2027-07-15T00:00:00.000Z");

describe("variantYearsUnset", () => {
    beforeEach(() => findMany.mockReset());

    it("off season, asks about the live year and the coming year and counts each missing row", async () => {
        findMany.mockResolvedValue([]);
        await expect(variantYearsUnset(boundary, offSeason)).resolves.toBe(2);
        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { membershipYear: { in: [2026, 2027] } } }));
    });

    it("counts only the year with no row", async () => {
        findMany.mockResolvedValue([{ membershipYear: 2026 }]);
        await expect(variantYearsUnset(boundary, offSeason)).resolves.toBe(1);
    });

    it("inside the window the live year is the coming year, so a missing row counts once", async () => {
        findMany.mockResolvedValue([]);
        await expect(variantYearsUnset(boundary, inWindow)).resolves.toBe(1);
        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { membershipYear: { in: [2027] } } }));
    });

    it("counts nothing with both rows", async () => {
        findMany.mockResolvedValue([{ membershipYear: 2026 }, { membershipYear: 2027 }]);
        await expect(variantYearsUnset(boundary, offSeason)).resolves.toBe(0);
    });

    it("does not count anything with no boundary, which is its own term", async () => {
        await expect(variantYearsUnset(null, offSeason)).resolves.toBe(0);
        expect(findMany).not.toHaveBeenCalled();
    });
});
