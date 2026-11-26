/**
 * @jest-environment node
 */
import { kindOf } from "@checkin/component-kit";
import { gmailTokenSource } from "../gmailToken";

const send = jest.fn();
jest.mock("@aws-sdk/client-lambda", () => ({ LambdaClient: jest.fn(() => ({ send })), InvokeCommand: jest.fn() }));

const MAILBOX = "receipts@example.com";
const answer = (over: Record<string, unknown> = {}) => ({ accessToken: "tok-1", expiresAt: Date.now() + 3600_000, mailbox: MAILBOX, ...over });
const failure = (invoke: jest.Mock) => gmailTokenSource("gmail-refresher", MAILBOX, invoke)().catch((e: unknown) => e);

describe("gmailTokenSource", () => {
    it("hands out the token for our mailbox, matched case-insensitively", async () => {
        const invoke = jest.fn().mockResolvedValue(answer({ mailbox: "Receipts@Example.com" }));
        await expect(gmailTokenSource("gmail-refresher", MAILBOX, invoke)()).resolves.toBe("tok-1");
    });

    it("refuses an answer for another mailbox as settings, naming the setting and who checks it", async () => {
        const err = await failure(jest.fn().mockResolvedValue(answer({ mailbox: "other@example.com" })));
        expect(kindOf(err)).toBe("settings");
        expect((err as Error).message).toMatch(/different mailbox.*RECEIPT_MAILBOX_ADDRESS.*Ops/);
        expect((err as Error).message).not.toContain("other@example.com");
    });

    it("refuses a malformed answer as settings, naming the setting and who checks it", async () => {
        const err = await failure(jest.fn().mockResolvedValue({ accessToken: "" }));
        expect(kindOf(err)).toBe("settings");
        expect((err as Error).message).toMatch(/GMAIL_REFRESHER_FN.*Ops/);
    });

    it("refuses a refresher Lambda's non-JSON answer as settings through the default invoke", async () => {
        send.mockResolvedValueOnce({ Payload: new TextEncoder().encode("<html>not a refresher</html>") });
        const err = await gmailTokenSource("gmail-refresher", MAILBOX)().catch((e: unknown) => e);
        expect(kindOf(err)).toBe("settings");
        expect((err as Error).message).toMatch(/GMAIL_REFRESHER_FN.*Ops/);
    });

    it("answers a failure from memory for a minute, then asks the refresher again", async () => {
        jest.useFakeTimers();
        try {
            const revoked = new Error("revoked");
            const invoke = jest.fn().mockRejectedValueOnce(revoked).mockResolvedValue(answer());
            const token = gmailTokenSource("gmail-refresher", MAILBOX, invoke);
            await expect(token()).rejects.toBe(revoked);
            await expect(token()).rejects.toBe(revoked);
            expect(invoke).toHaveBeenCalledTimes(1);
            jest.advanceTimersByTime(60_001);
            await expect(token()).resolves.toBe("tok-1");
            expect(invoke).toHaveBeenCalledTimes(2);
        } finally {
            jest.useRealTimers();
        }
    });
});
