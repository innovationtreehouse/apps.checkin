import prisma from "@/lib/prisma";
import { householdPaymentViewer } from "../paymentVisibility";

jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: { person: { findFirst: jest.fn() } },
}));

const findFirst = prisma.person.findFirst as jest.Mock;

describe("householdPaymentViewer", () => {
    beforeEach(() => findFirst.mockReset());

    it.each([
        ["an adult by DOB", { dateOfBirth: "1990-01-01", isDeclaredAdult: false }],
        ["a declared adult", { dateOfBirth: null, isDeclaredAdult: true }],
    ])("gives %s lead their household", async (_label, age) => {
        findFirst.mockResolvedValue({ ...age, householdId: 7 });
        await expect(householdPaymentViewer(1)).resolves.toEqual({ householdId: 7 });
    });

    it.each([
        ["a youth", { dateOfBirth: "2015-01-01", isDeclaredAdult: false }],
        ["an unknown age", { dateOfBirth: null, isDeclaredAdult: false }],
    ])("gives %s lead nothing", async (_label, age) => {
        findFirst.mockResolvedValue({ ...age, householdId: 7 });
        await expect(householdPaymentViewer(1)).resolves.toBeNull();
    });

    it("gives a non-lead nothing", async () => {
        findFirst.mockResolvedValue(null);
        await expect(householdPaymentViewer(1)).resolves.toBeNull();
    });
});
