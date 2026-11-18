/**
 * @jest-environment node
 */
import { findMembershipLine, membershipVariantYears } from "../reconcile/membership";
import prisma from "@/lib/prisma";
import { config, DEV_MOCK_MEMBERSHIP_VARIANT_ID } from "@/lib/config";

jest.mock("@/lib/prisma", () => ({ __esModule: true, default: { membershipYearVariant: { findMany: jest.fn() } } }));
jest.mock("@/lib/membership/payment", () => ({ activateByProcessId: jest.fn() }));

const findMany = prisma.membershipYearVariant.findMany as jest.Mock;
const mockActive = jest.spyOn(config, "shopifyMockActive");
const settings = { orgMembershipYearBoundary: new Date(Date.UTC(2000, 8, 1)) };
const JUNE = new Date(Date.UTC(2027, 5, 20));

beforeEach(() => {
    findMany.mockResolvedValue([]);
    mockActive.mockReturnValue(false);
});

describe("membershipVariantYears", () => {
    it("maps each row's variant to its year", async () => {
        findMany.mockResolvedValue([{ shopifyVariantId: "v26", membershipYear: 2026 }]);
        expect((await membershipVariantYears(null, JUNE)).get("v26")).toBe(2026);
    });

    it("includes the dev mock variant only while the mock is active", async () => {
        expect((await membershipVariantYears(settings, JUNE)).has(DEV_MOCK_MEMBERSHIP_VARIANT_ID)).toBe(false);
        mockActive.mockReturnValue(true);
        expect((await membershipVariantYears(settings, JUNE)).get(DEV_MOCK_MEMBERSHIP_VARIANT_ID)).toBe(2026);
    });

    it("a row outranks the dev mock variant's live year", async () => {
        mockActive.mockReturnValue(true);
        findMany.mockResolvedValue([{ shopifyVariantId: DEV_MOCK_MEMBERSHIP_VARIANT_ID, membershipYear: 2031 }]);
        expect((await membershipVariantYears(settings, JUNE)).get(DEV_MOCK_MEMBERSHIP_VARIANT_ID)).toBe(2031);
    });
});

describe("findMembershipLine", () => {
    const years = new Map<string, number | null>([["v26", 2026], ["unyeared", null]]);

    it("returns the year of the membership line among the order's lines", () => {
        expect(findMembershipLine(years, ["shirt", "v26"])).toEqual({ appliesToYear: 2026 });
    });

    it("still finds a line with no year", () => {
        expect(findMembershipLine(years, ["unyeared"])).toEqual({ appliesToYear: null });
    });

    it("is null when no line's variant is mapped", () => {
        expect(findMembershipLine(years, ["shirt"])).toBeNull();
    });
});
