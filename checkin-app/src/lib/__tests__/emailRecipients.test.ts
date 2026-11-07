import prisma from "@/lib/prisma";
import { sendTemplated } from "@/lib/email-templates/send";
import { logBackendError } from "@/lib/logger";
import { emailAlert, emailBoardMembers } from "@/lib/emailRecipients";

jest.mock("@/lib/prisma", () => ({ __esModule: true, default: { person: { findMany: jest.fn() }, boardSettings: { findUnique: jest.fn() } } }));
jest.mock("@/lib/email-templates/send", () => ({ sendTemplated: jest.fn() }));
jest.mock("@/lib/logger", () => ({ ...jest.requireActual("@/lib/logger"), logBackendError: jest.fn() }));

const findPeople = prisma.person.findMany as jest.Mock;
const send = jest.mocked(sendTemplated);
const CTX = { programName: "Robots", names: "A Kid", actionLink: "https://example.com/p/1" };

describe("emailBoardMembers delivered count", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        findPeople.mockResolvedValue([{ email: "a@example.com" }, { email: "b@example.com" }]);
    });

    it("counts every recipient the provider accepted", async () => {
        send.mockResolvedValue(true);
        await expect(emailBoardMembers("board.unpaidClaims", CTX, "label")).resolves.toBe(2);
    });

    it("counts only the accepted ones on a partial failure", async () => {
        send.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        await expect(emailBoardMembers("board.unpaidClaims", CTX, "label")).resolves.toBe(1);
    });

    it("is zero when every send fails", async () => {
        send.mockResolvedValue(false);
        await expect(emailBoardMembers("board.unpaidClaims", CTX, "label")).resolves.toBe(0);
    });

    it("is zero when no Board member has an address", async () => {
        findPeople.mockResolvedValue([]);
        await expect(emailBoardMembers("board.unpaidClaims", CTX, "label")).resolves.toBe(0);
    });

    it("is zero when the recipient query fails, and does not reject", async () => {
        const logged = jest.spyOn(console, "error").mockImplementation();
        findPeople.mockRejectedValue(new Error("db down"));
        await expect(emailBoardMembers("board.unpaidClaims", CTX, "label")).resolves.toBe(0);
        expect(logged).toHaveBeenCalledWith("label", expect.any(Error));
        logged.mockRestore();
    });
});

describe("emailAlert", () => {
    const findSettings = prisma.boardSettings.findUnique as jest.Mock;
    const ALERT_CTX = { since: "2026-10-01", actionLink: "https://example.com/income" };

    beforeEach(() => jest.clearAllMocks());

    it("sends to the alert address alone, without reading anyone's preferences", async () => {
        findSettings.mockResolvedValue({ alertEmailAddress: "finance@example.org" });
        send.mockResolvedValue(true);
        await expect(emailAlert("finance.incomeSweepIncomplete", ALERT_CTX)).resolves.toBe(true);
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith("finance.incomeSweepIncomplete", "finance@example.org", ALERT_CTX);
        expect(findPeople).not.toHaveBeenCalled();
    });

    it("sends nothing when the address is unset, with no fallback, and logs the gap", async () => {
        findSettings.mockResolvedValue({ alertEmailAddress: null });
        await expect(emailAlert("finance.incomeSweepIncomplete", ALERT_CTX)).resolves.toBe(false);
        expect(send).not.toHaveBeenCalled();
        expect(findPeople).not.toHaveBeenCalled();
        expect(logBackendError).toHaveBeenCalledWith(expect.any(Error), "emailAlert", { key: "finance.incomeSweepIncomplete" });
    });

    it("sends nothing when no settings row exists", async () => {
        findSettings.mockResolvedValue(null);
        await expect(emailAlert("finance.incomeSweepIncomplete", ALERT_CTX)).resolves.toBe(false);
        expect(send).not.toHaveBeenCalled();
    });

    it("does not reject when the settings read fails", async () => {
        const logged = jest.spyOn(console, "error").mockImplementation();
        findSettings.mockRejectedValue(new Error("db down"));
        await expect(emailAlert("finance.incomeSweepIncomplete", ALERT_CTX)).resolves.toBe(false);
        expect(logged).toHaveBeenCalledWith("emailAlert finance.incomeSweepIncomplete failed:", expect.any(Error));
        logged.mockRestore();
    });
});
