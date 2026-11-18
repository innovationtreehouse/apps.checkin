import { notifyClearanceOutcome, type ClearanceOutcome } from "@/lib/membership/review";
import { sendCongrats } from "@/lib/membership/payment";
import { openPersonBgForNewMember } from "@/lib/membership/personBgTriggers";
import { openPersonAgreementForNewMember } from "@/lib/membership/personAgreementTriggers";
import { raisePaymentException } from "@/lib/finance/reconcile/exceptions";
import { logBackendError } from "@/lib/logger";

jest.mock("@/lib/membership/payment", () => ({ sendCongrats: jest.fn() }));
jest.mock("@/lib/membership/personBgTriggers", () => ({ openPersonBgForNewMember: jest.fn() }));
jest.mock("@/lib/membership/personAgreementTriggers", () => ({ openPersonAgreementForNewMember: jest.fn() }));
jest.mock("@/lib/membership/boardAlerts", () => ({ notifyBoardPaidReject: jest.fn(), notifyBoardPaymentException: jest.fn() }));
jest.mock("@/lib/finance/reconcile/exceptions", () => ({ raisePaymentException: jest.fn(), recordPaymentException: jest.fn(), isOrderReversed: jest.fn() }));
jest.mock("@/lib/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
    logBackendError: jest.fn(),
}));

const activatedInitial: ClearanceOutcome = { status: "ACTIVE", activated: true, householdId: 5, isInitial: true };

beforeEach(() => jest.resetAllMocks());

describe("notifyClearanceOutcome after the clearance has committed", () => {
    it("runs the agreement trigger when the background-check trigger throws, and logs the failure", async () => {
        const failure = new Error("db down");
        (openPersonBgForNewMember as jest.Mock).mockRejectedValue(failure);

        await expect(notifyClearanceOutcome(activatedInitial)).resolves.toBeUndefined();

        expect(openPersonAgreementForNewMember).toHaveBeenCalledWith(5, expect.any(Date));
        expect(logBackendError).toHaveBeenCalledWith(failure, "clearance person background-check trigger", expect.objectContaining({ householdId: 5 }));
    });

    it("runs the triggers when the congrats email throws", async () => {
        (sendCongrats as jest.Mock).mockRejectedValue(new Error("config"));

        await expect(notifyClearanceOutcome(activatedInitial)).resolves.toBeUndefined();

        expect(openPersonBgForNewMember).toHaveBeenCalled();
        expect(openPersonAgreementForNewMember).toHaveBeenCalled();
    });

    it("does not throw when the agreement trigger throws", async () => {
        (openPersonAgreementForNewMember as jest.Mock).mockRejectedValue(new Error("db down"));
        await expect(notifyClearanceOutcome(activatedInitial)).resolves.toBeUndefined();
        expect(logBackendError).toHaveBeenCalled();
    });

    it("does not throw when the refunded order's raise throws", async () => {
        (raisePaymentException as jest.Mock).mockRejectedValue(new Error("db down"));
        const outcome: ClearanceOutcome = { status: "PENDING_BG_CLEARANCE", activated: false, householdId: null, isInitial: false, refunded: { processId: 7, shopifyOrderId: "1" } };

        await expect(notifyClearanceOutcome(outcome)).resolves.toBeUndefined();

        expect(logBackendError).toHaveBeenCalledWith(expect.any(Error), "clearance refunded order raise", expect.objectContaining({ processId: 7 }));
    });
});
