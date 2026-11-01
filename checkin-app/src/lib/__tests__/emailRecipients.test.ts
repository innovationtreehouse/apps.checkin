import prisma from "@/lib/prisma";
import { sendTemplated } from "@/lib/email-templates/send";
import { emailBoardMembers } from "@/lib/emailRecipients";

jest.mock("@/lib/prisma", () => ({ __esModule: true, default: { person: { findMany: jest.fn() } } }));
jest.mock("@/lib/email-templates/send", () => ({ sendTemplated: jest.fn() }));

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
