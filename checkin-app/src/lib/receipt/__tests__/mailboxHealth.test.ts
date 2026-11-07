/**
 * @jest-environment node
 */
import { KindedError } from "@checkin/component-kit";
import { getReceiptMailboxHealth } from "../mailboxHealth";

const receiptMailboxConfig = jest.fn();
jest.mock("@/lib/receipt/mailboxConfig", () => ({ receiptMailboxConfig: () => receiptMailboxConfig() }));
const current = jest.fn();
jest.mock("@/lib/receipt/gmailToken", () => ({ gmailAccessToken: () => current }));

const BOUND = { bound: true, functionName: "gmail-refresher", mailboxAddress: "receipts@example.com" };

beforeEach(() => {
    jest.clearAllMocks();
    receiptMailboxConfig.mockReturnValue(BOUND);
});

describe("receipt mailbox connection row", () => {
    it("is absent while intake is unbound", async () => {
        receiptMailboxConfig.mockReturnValue({ bound: false, refused: null });
        await expect(getReceiptMailboxHealth()).resolves.toEqual([]);
        expect(current).not.toHaveBeenCalled();
    });

    it("is connected when the refresher hands out a token, and never names it", async () => {
        current.mockResolvedValue("tok");
        await expect(getReceiptMailboxHealth()).resolves.toEqual([
            { id: "receipt-mailbox-connection", label: "Receipt mailbox connection", ok: true, detail: "Connected." },
        ]);
    });

    it("says it needs reconnecting by ops when the refresher answers reconsent-required", async () => {
        current.mockRejectedValue(new KindedError("connection", "The receipt mailbox needs reconnecting: its Gmail login was revoked. Ops reconnects it by re-running the Gmail consent."));
        const [row] = await getReceiptMailboxHealth();
        expect(row).toMatchObject({ ok: false, detail: expect.stringMatching(/needs reconnecting.*Ops reconnects/) });
    });

    it("says the refresher failed on any other failure", async () => {
        current.mockRejectedValue(new KindedError("system", "Gmail token refresher gmail-refresher failed"));
        const [row] = await getReceiptMailboxHealth();
        expect(row).toMatchObject({ ok: false, detail: "Off: the token refresher failed (Gmail token refresher gmail-refresher failed)." });
    });
});
