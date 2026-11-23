import { notifyClearanceOutcome, type ClearanceOutcome } from "@/lib/membership/review";
import { sendCongrats } from "@/lib/membership/payment";
import { openPersonBgForNewMember } from "@/lib/membership/personBgTriggers";
import { openPersonAgreementForNewMember } from "@/lib/membership/personAgreementTriggers";
import { raisePaymentException } from "@/lib/finance/reconcile/exceptions";
import { logBackendError } from "@/lib/logger";
import prisma from "@/lib/prisma";

jest.mock("@/lib/membership/payment", () => ({ sendCongrats: jest.fn() }));
jest.mock("@/lib/membership/personBgTriggers", () => ({ openPersonBgForNewMember: jest.fn() }));
jest.mock("@/lib/membership/personAgreementTriggers", () => ({ openPersonAgreementForNewMember: jest.fn() }));
jest.mock("@/lib/membership/boardAlerts", () => ({ notifyBoardPaidReject: jest.fn(), notifyBoardPaymentException: jest.fn() }));
jest.mock("@/lib/finance/reconcile/exceptions", () => ({ raisePaymentException: jest.fn(), recordPaymentException: jest.fn(), isOrderReversed: jest.fn() }));
jest.mock("@/lib/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
    logBackendError: jest.fn(),
}));

const activatedInitial: ClearanceOutcome = { status: "ACTIVE", activated: true, processId: 9, householdId: 5, isInitial: true };
const recordStuck = jest.fn();
const stuckSteps = () => recordStuck.mock.calls.map(([args]) => args.create.step);

beforeEach(() => {
    jest.resetAllMocks();
    prisma.clearanceStepFailure.upsert = recordStuck;
});

describe("notifyClearanceOutcome after the clearance has committed", () => {
    it("runs the agreement trigger when the background-check trigger throws, and keeps the failure as a stuck item", async () => {
        const failure = new Error("db down");
        (openPersonBgForNewMember as jest.Mock).mockRejectedValue(failure);

        await expect(notifyClearanceOutcome(activatedInitial)).resolves.toBeUndefined();

        expect(openPersonAgreementForNewMember).toHaveBeenCalledWith(5, expect.any(Date));
        expect(logBackendError).toHaveBeenCalledWith(failure, "clearance person background-check trigger", expect.objectContaining({ householdId: 5, processId: 9 }));
        expect(recordStuck).toHaveBeenCalledWith({
            where: { processId_step: { processId: 9, step: "PERSON_BG_TRIGGER" } },
            create: { processId: 9, step: "PERSON_BG_TRIGGER", failedAt: expect.any(Date), error: "db down" },
            update: { error: "db down" },
        });
    });

    it("re-runs a trigger as of the clearance time it first ran with", async () => {
        (openPersonBgForNewMember as jest.Mock).mockRejectedValue(new Error("db down"));

        await notifyClearanceOutcome(activatedInitial);

        const asOf = (openPersonBgForNewMember as jest.Mock).mock.calls[0][1];
        expect(recordStuck.mock.calls[0][0].create.failedAt).toBe(asOf);
    });

    it("records nothing stuck when every step succeeds", async () => {
        await notifyClearanceOutcome(activatedInitial);
        expect(recordStuck).not.toHaveBeenCalled();
    });

    it("runs the triggers when the congrats email throws", async () => {
        (sendCongrats as jest.Mock).mockRejectedValue(new Error("config"));

        await expect(notifyClearanceOutcome(activatedInitial)).resolves.toBeUndefined();

        expect(openPersonBgForNewMember).toHaveBeenCalled();
        expect(openPersonAgreementForNewMember).toHaveBeenCalled();
        expect(recordStuck).not.toHaveBeenCalled();
    });

    it("does not throw when the agreement trigger throws", async () => {
        (openPersonAgreementForNewMember as jest.Mock).mockRejectedValue(new Error("db down"));
        await expect(notifyClearanceOutcome(activatedInitial)).resolves.toBeUndefined();
        expect(logBackendError).toHaveBeenCalled();
        expect(stuckSteps()).toEqual(["PERSON_AGREEMENT_TRIGGER"]);
    });

    it("does not throw when the stuck item cannot be recorded", async () => {
        (openPersonAgreementForNewMember as jest.Mock).mockRejectedValue(new Error("db down"));
        recordStuck.mockRejectedValue(new Error("still down"));

        await expect(notifyClearanceOutcome(activatedInitial)).resolves.toBeUndefined();
        expect(logBackendError).toHaveBeenCalledWith(expect.any(Error), "recording a stuck clearance step", expect.objectContaining({ processId: 9 }));
    });

    it("does not throw when the refunded order's raise throws", async () => {
        (raisePaymentException as jest.Mock).mockRejectedValue(new Error("db down"));
        const outcome: ClearanceOutcome = { status: "PENDING_BG_CLEARANCE", activated: false, processId: 7, householdId: null, isInitial: false, refunded: { shopifyOrderId: "1" } };

        await expect(notifyClearanceOutcome(outcome)).resolves.toBeUndefined();

        expect(raisePaymentException).toHaveBeenCalledWith("REVERSED_BEFORE_ACTIVATION", { processId: 7, shopifyOrderId: "1", severity: "CRITICAL" });
        expect(logBackendError).toHaveBeenCalledWith(expect.any(Error), "clearance refunded order raise", expect.objectContaining({ processId: 7 }));
        expect(stuckSteps()).toEqual(["REFUNDED_ORDER_RAISE"]);
    });
});
