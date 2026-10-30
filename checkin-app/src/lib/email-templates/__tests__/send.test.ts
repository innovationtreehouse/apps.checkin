import { sendEmail } from "@/lib/email";
import prisma from "@/lib/prisma";
import { baseEmailLayout } from "../base";
import { sendTemplated } from "../send";
import { renderBodyHtml } from "../tokens";

jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: { emailTemplate: { findUnique: jest.fn() } },
}));
jest.mock("@/lib/email", () => ({ sendEmail: jest.fn() }));

const findUnique = prisma.emailTemplate.findUnique as jest.Mock;
const send = sendEmail as jest.Mock;

const enrollment = { name: "O'Brien <x>", programName: "Arts & Crafts" };

beforeEach(() => {
    jest.clearAllMocks();
    findUnique.mockResolvedValue(null);
    send.mockResolvedValue(true);
});

describe("renderBodyHtml", () => {
    it("makes a paragraph per blank line and a <br> per single newline", () => {
        expect(renderBodyHtml("One\ntwo\n\nThree")).toBe("<p>One<br>two</p><p>Three</p>");
    });

    it("treats CRLF and whitespace-only lines like plain newlines and blank lines", () => {
        expect(renderBodyHtml("One\r\ntwo\r\n  \r\nThree")).toBe("<p>One<br>two</p><p>Three</p>");
    });

    it("drops empty paragraphs", () => {
        expect(renderBodyHtml("One\n\n\n\n  \n\nTwo\n\n")).toBe("<p>One</p><p>Two</p>");
        expect(renderBodyHtml("")).toBe("");
    });
});

describe("sendTemplated", () => {
    it("sends the registry default when no row exists, with a raw subject and an escaped body", async () => {
        await expect(sendTemplated("enrollment.confirm", "a@example.org", enrollment)).resolves.toBe(true);

        expect(findUnique).toHaveBeenCalledWith({ where: { key: "enrollment.confirm" }, select: { subject: true, body: true } });
        expect(send).toHaveBeenCalledWith(
            "a@example.org",
            "Confirmed: Enrollment in Arts & Crafts",
            baseEmailLayout("<p>Hi O&#39;Brien &lt;x&gt;, you have been successfully enrolled in Arts &amp; Crafts.</p>"),
        );
    });

    it("sends the row when one exists", async () => {
        findUnique.mockResolvedValue({ subject: "Saved {{programName}}", body: "Line one\nLine two\n\n{{name}}" });

        await sendTemplated("enrollment.confirm", "a@example.org", enrollment);

        expect(send).toHaveBeenCalledWith(
            "a@example.org",
            "Saved Arts & Crafts",
            baseEmailLayout("<p>Line one<br>Line two</p><p>O&#39;Brien &lt;x&gt;</p>"),
        );
    });

    it("falls back field by field when a row's subject or body is blank", async () => {
        findUnique.mockResolvedValue({ subject: "  ", body: "Saved body" });
        await sendTemplated("enrollment.confirm", "a@example.org", enrollment);
        expect(send.mock.calls[0][1]).toBe("Confirmed: Enrollment in Arts & Crafts");
        expect(send.mock.calls[0][2]).toContain("<p>Saved body</p>");

        findUnique.mockResolvedValue({ subject: "Saved subject", body: "\n\n" });
        await sendTemplated("enrollment.confirm", "a@example.org", enrollment);
        expect(send.mock.calls[1][1]).toBe("Saved subject");
        expect(send.mock.calls[1][2]).toContain("successfully enrolled");
    });

    it("drops a paragraph whose only token is empty", async () => {
        const ctx = { name: "Alex", emoji: "✅", visitWord: "Started", action: "checked in to", date: "Mar 7", time: "10:05" };

        await sendTemplated("checkin.receipt", "a@example.org", { ...ctx, via: "" });
        expect(send.mock.calls[0][2]).toContain("<p>📅 Mar 7<br>🕐 10:05</p>\n");

        await sendTemplated("checkin.receipt", "a@example.org", { ...ctx, via: "📍 via badge scan" });
        expect(send.mock.calls[1][2]).toContain("<p>📅 Mar 7<br>🕐 10:05</p><p>📍 via badge scan</p>");
    });

    it("renders a multi-line token value with <br>", async () => {
        findUnique.mockResolvedValue({ subject: "s", body: "{{names}}" });

        await sendTemplated("board.unpaidClaims", "a@example.org", { names: "Ann\nBob" });

        expect(send.mock.calls[0][2]).toContain("<p>Ann<br>Bob</p>");
    });

    it("renders a link token with its fixed label", async () => {
        await sendTemplated("program.assignment", "a@example.org", { programName: "Robotics", actionLink: "https://x.test/p?a=1&b=2" });

        expect(send.mock.calls[0][2]).toContain('You can manage it <a href="https://x.test/p?a=1&amp;b=2">here</a>.');
    });

    it("returns false when sendEmail fails, so callers can retry", async () => {
        send.mockResolvedValue(false);

        await expect(sendTemplated("enrollment.confirm", "a@example.org", enrollment)).resolves.toBe(false);
    });

    it("sends the default when the template lookup fails", async () => {
        findUnique.mockRejectedValue(new Error("db down"));
        const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);

        await expect(sendTemplated("enrollment.confirm", "a@example.org", enrollment)).resolves.toBe(true);

        expect(send.mock.calls[0][1]).toBe("Confirmed: Enrollment in Arts & Crafts");
        expect(consoleError).toHaveBeenCalled();
        consoleError.mockRestore();
    });
});
