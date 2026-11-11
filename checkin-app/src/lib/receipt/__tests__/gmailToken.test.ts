/**
 * @jest-environment node
 */
import { kindOf } from "@checkin/component-kit";
import { gmailTokenSource } from "../gmailToken";

jest.mock("@aws-sdk/client-lambda", () => ({ LambdaClient: jest.fn(), InvokeCommand: jest.fn() }));

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
});
