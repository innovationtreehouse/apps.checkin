import prisma from "@/lib/prisma";
import { comingYearVariantUnset } from "@/lib/nav/todoCounts";

jest.mock("@/lib/prisma", () => ({ __esModule: true, default: { membershipYearVariant: { findUnique: jest.fn() } } }));

const findUnique = prisma.membershipYearVariant.findUnique as jest.Mock;
const boundary = new Date("2000-09-01T00:00:00.000Z");
const now = new Date("2026-11-01T00:00:00.000Z");

describe("comingYearVariantUnset", () => {
    beforeEach(() => findUnique.mockReset());

    it("counts a coming year with no row, asking about the coming year", async () => {
        findUnique.mockResolvedValue(null);
        await expect(comingYearVariantUnset(boundary, now)).resolves.toBe(true);
        expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { membershipYear: 2027 } }));
    });

    it("does not count a coming year with a row", async () => {
        findUnique.mockResolvedValue({ membershipYear: 2027 });
        await expect(comingYearVariantUnset(boundary, now)).resolves.toBe(false);
    });

    it("does not count anything with no boundary, which is its own term", async () => {
        await expect(comingYearVariantUnset(null, now)).resolves.toBe(false);
        expect(findUnique).not.toHaveBeenCalled();
    });
});
