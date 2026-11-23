/**
 * @jest-environment node
 */
import { raisePaymentException } from "@/lib/finance/reconcile/exceptions";
import { logBackendError } from "@/lib/logger";
import { openPersonAgreementForNewMember } from "@/lib/membership/personAgreementTriggers";
import { openPersonBgForNewMember } from "@/lib/membership/personBgTriggers";
import prisma from "@/lib/prisma";
import { isClearanceStepName, retryClearanceStep, stuckClearanceSteps } from "@/lib/membership/clearanceSteps";

jest.mock("@/lib/finance/reconcile/exceptions", () => ({ raisePaymentException: jest.fn() }));
jest.mock("@/lib/membership/personBgTriggers", () => ({ openPersonBgForNewMember: jest.fn() }));
jest.mock("@/lib/membership/personAgreementTriggers", () => ({ openPersonAgreementForNewMember: jest.fn() }));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() }, logBackendError: jest.fn() }));

const FAILED_AT = new Date("2026-11-20T10:00:00Z");
const findStuck = jest.fn();
const clearStuck = jest.fn();
const recordError = jest.fn();

beforeEach(() => {
    jest.resetAllMocks();
    prisma.clearanceStepFailure.findUnique = findStuck;
    prisma.clearanceStepFailure.deleteMany = clearStuck;
    prisma.clearanceStepFailure.updateMany = recordError;
    findStuck.mockResolvedValue({ id: 3, failedAt: FAILED_AT, process: { shopifyOrderId: "5001", orgMembership: { householdId: 4 } } });
});

describe("retryClearanceStep", () => {
    it.each([
        ["person background-check trigger", openPersonBgForNewMember],
        ["person agreement trigger", openPersonAgreementForNewMember],
    ])("re-runs only the %s, as of its first failure, and clears the item", async (step, trigger) => {
        await retryClearanceStep({ id: "12", step });

        expect(trigger).toHaveBeenCalledWith(4, FAILED_AT);
        expect(raisePaymentException).not.toHaveBeenCalled();
        expect(clearStuck).toHaveBeenCalledWith({ where: { id: 3 } });
    });

    it("raises the refunded order again against the application's order", async () => {
        await retryClearanceStep({ id: "12", step: "refunded order raise" });

        expect(findStuck).toHaveBeenCalledWith(expect.objectContaining({ where: { processId_step: { processId: 12, step: "REFUNDED_ORDER_RAISE" } } }));
        expect(raisePaymentException).toHaveBeenCalledWith("REVERSED_BEFORE_ACTIVATION", { processId: 12, shopifyOrderId: "5001", severity: "CRITICAL" });
        expect(openPersonBgForNewMember).not.toHaveBeenCalled();
        expect(clearStuck).toHaveBeenCalled();
    });

    it("keeps the item and its first failure time when the step fails again, answering 409", async () => {
        jest.mocked(openPersonBgForNewMember).mockRejectedValue(new Error("db down"));

        await expect(retryClearanceStep({ id: "12", step: "person background-check trigger" })).rejects.toMatchObject({ status: 409 });

        expect(recordError).toHaveBeenCalledWith({ where: { id: 3 }, data: { error: "db down" } });
        expect(logBackendError).toHaveBeenCalled();
        expect(clearStuck).not.toHaveBeenCalled();
    });

    it("answers 404 for an item that is not stuck, and runs nothing", async () => {
        findStuck.mockResolvedValue(null);

        await expect(retryClearanceStep({ id: "12", step: "person agreement trigger" })).rejects.toMatchObject({ status: 404 });
        expect(openPersonAgreementForNewMember).not.toHaveBeenCalled();
    });

    it.each([
        ["an unknown step", { id: "12", step: "congrats email" }],
        ["a non-numeric id", { id: "12; drop", step: "person agreement trigger" }],
        ["an id of zero", { id: "0", step: "person agreement trigger" }],
    ])("answers 404 for %s", async (_what, item) => {
        await expect(retryClearanceStep(item)).rejects.toMatchObject({ status: 404 });
        expect(findStuck).not.toHaveBeenCalled();
    });
});

describe("stuckClearanceSteps", () => {
    it("names each item by its application and step, timed by its first failure", async () => {
        prisma.clearanceStepFailure.findMany = jest.fn().mockResolvedValue([
            { processId: 12, step: "REFUNDED_ORDER_RAISE", failedAt: FAILED_AT, process: { orgMembership: { householdId: 4 } } },
            { processId: 13, step: "PERSON_AGREEMENT_TRIGGER", failedAt: FAILED_AT, process: { orgMembership: null } },
        ]);

        expect(await stuckClearanceSteps()).toEqual([
            { id: "12", step: "refunded order raise", href: "/membership-ops/households/4", failedAt: FAILED_AT },
            { id: "13", step: "person agreement trigger", href: null, failedAt: FAILED_AT },
        ]);
    });
});

it("tells its steps from the settle's", () => {
    expect(isClearanceStepName("person agreement trigger")).toBe(true);
    expect(isClearanceStepName("background-check settle")).toBe(false);
});
