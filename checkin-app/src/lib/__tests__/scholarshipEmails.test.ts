import prisma from "@/lib/prisma";
import {
    resolveScholarshipRecipients,
    notifyReviewTeam,
    sendScholarshipAck,
    renderAckBody,
    resolveAckCopy,
    DEFAULT_ACK_SUBJECT,
    DEFAULT_ACK_MEMBERSHIP_BODY,
    DEFAULT_ACK_PROGRAM_BODY,
} from "../scholarshipEmails";

jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        person: { findMany: jest.fn() },
        boardSettings: { findUnique: jest.fn() },
    },
}));

jest.mock("@/lib/email");
// `@/lib/email`'s real module has no __getSentEmails/__clearSentEmails — those
// only exist on the manual mock (src/lib/__mocks__/email.ts) that jest.mock
// above swaps in. jest.requireMock (not a direct import) fetches that swapped
// instance so this typechecks against the mock's own shape.
const { __getSentEmails, __clearSentEmails } =
    jest.requireMock<typeof import("@/lib/__mocks__/email")>("@/lib/email");

afterEach(() => {
    __clearSentEmails();
    jest.clearAllMocks();
});

describe("resolveScholarshipRecipients", () => {
    it("leads-only when no alsoPersonId", async () => {
        (prisma.person.findMany as jest.Mock).mockResolvedValue([
            { email: "lead@x.org", notificationSettings: null },
        ]);

        const result = await resolveScholarshipRecipients(1);

        expect(prisma.person.findMany).toHaveBeenCalledWith({
            where: { householdId: 1, isHouseholdLead: true },
            select: { email: true, notificationSettings: true },
        });
        expect(result).toEqual([{ email: "lead@x.org", settings: null }]);
    });

    it("leads ∪ extra person when alsoPersonId is given", async () => {
        (prisma.person.findMany as jest.Mock).mockResolvedValue([
            { email: "lead@x.org", notificationSettings: null },
            { email: "kid@x.org", notificationSettings: null },
        ]);

        const result = await resolveScholarshipRecipients(1, 42);

        expect(prisma.person.findMany).toHaveBeenCalledWith({
            where: { householdId: 1, OR: [{ isHouseholdLead: true }, { id: 42 }] },
            select: { email: true, notificationSettings: true },
        });
        expect(result.map((r) => r.email).sort()).toEqual(["kid@x.org", "lead@x.org"]);
    });

    it("dedupes when the extra person is a lead (same email → one entry)", async () => {
        (prisma.person.findMany as jest.Mock).mockResolvedValue([
            { email: "Lead@X.org", notificationSettings: null },
            { email: "lead@x.org", notificationSettings: { someOtherPreference: false } },
        ]);

        const result = await resolveScholarshipRecipients(1, 42);

        expect(result).toHaveLength(1);
        expect(result[0].email).toBe("Lead@X.org"); // first-seen entry kept
    });

    it("a null-email child drops out (covered by leads)", async () => {
        (prisma.person.findMany as jest.Mock).mockResolvedValue([
            { email: "lead@x.org", notificationSettings: null },
            { email: null, notificationSettings: null },
        ]);

        const result = await resolveScholarshipRecipients(1, 42);

        expect(result).toEqual([{ email: "lead@x.org", settings: null }]);
    });

    it("swallows a prisma error and returns []", async () => {
        (prisma.person.findMany as jest.Mock).mockRejectedValue(new Error("db down"));

        const result = await resolveScholarshipRecipients(1);

        expect(result).toEqual([]);
    });
});

describe("sendScholarshipAck", () => {
    it("ungated — sends to every recipient regardless of their notificationSettings", async () => {
        const recipients = [
            { email: "opted-out@x.org", settings: { someOtherPreference: false } },
            { email: "default-on@x.org", settings: null },
        ];

        await sendScholarshipAck(recipients, "Subject", "<p>Body</p>");

        const sent = __getSentEmails().map((e) => e.to).sort();
        expect(sent).toEqual(["default-on@x.org", "opted-out@x.org"]);
    });
});

describe("renderAckBody", () => {
    it("escapes HTML — a <script> payload renders inert", () => {
        const result = renderAckBody("hi <script>alert(1)</script> bye");
        expect(result).not.toContain("<script>");
        expect(result).toContain("&lt;script&gt;");
    });

    it("substitutes {{programName}}, escaping its value", () => {
        const result = renderAckBody("Request for {{programName}} received.", { programName: '<b>Camp "Fun"</b>' });
        expect(result).toBe('<p>Request for &lt;b&gt;Camp &quot;Fun&quot;&lt;/b&gt; received.</p>');
    });

    it("substitutes {{programName}} with an empty string when no value is given", () => {
        const result = renderAckBody("For {{programName}}.");
        expect(result).toBe("<p>For .</p>");
    });

    it("splits on line breaks into one <p> per non-empty line, dropping blank lines", () => {
        const result = renderAckBody("Line one.\n\nLine two.\n   \nLine three.");
        expect(result).toBe("<p>Line one.</p><p>Line two.</p><p>Line three.</p>");
    });

    it("a single-line template (today's shape) renders as exactly one paragraph", () => {
        const result = renderAckBody("Hi — we've received your request.");
        expect(result).toBe("<p>Hi — we&#39;ve received your request.</p>");
    });
});

describe("resolveAckCopy", () => {
    it("null settings fall back to the default subject + membership body", () => {
        const result = resolveAckCopy(null, "membership");
        expect(result.subject).toBe(DEFAULT_ACK_SUBJECT);
        expect(result.body).toBe(renderAckBody(DEFAULT_ACK_MEMBERSHIP_BODY));
    });

    it("blank/whitespace-only settings fall back, same as null", () => {
        const result = resolveAckCopy(
            { scholarshipAckSubject: "   ", scholarshipAckMembershipBody: "\n\t ", scholarshipAckProgramBody: undefined },
            "membership",
        );
        expect(result.subject).toBe(DEFAULT_ACK_SUBJECT);
        expect(result.body).toBe(renderAckBody(DEFAULT_ACK_MEMBERSHIP_BODY));
    });

    it("program variant falls back to the default program body with {{programName}} substituted", () => {
        const result = resolveAckCopy(null, "program", { programName: "Woodworking 101" });
        expect(result.body).toBe(renderAckBody(DEFAULT_ACK_PROGRAM_BODY, { programName: "Woodworking 101" }));
        expect(result.body).toContain("Woodworking 101");
    });

    it("a configured subject + body override the defaults, rendered through the same pipeline", () => {
        const result = resolveAckCopy(
            { scholarshipAckSubject: "Custom subject", scholarshipAckMembershipBody: "Custom body.", scholarshipAckProgramBody: null },
            "membership",
        );
        expect(result.subject).toBe("Custom subject");
        expect(result.body).toBe("<p>Custom body.</p>");
    });

    it("a configured program body substitutes {{programName}}", () => {
        const result = resolveAckCopy(
            { scholarshipAckSubject: null, scholarshipAckMembershipBody: null, scholarshipAckProgramBody: "Save your seat in {{programName}}!" },
            "program",
            { programName: "Robotics" },
        );
        expect(result.body).toBe("<p>Save your seat in Robotics!</p>");
    });

    it("a configured subject substitutes {{programName}}, unescaped (plain text)", () => {
        const result = resolveAckCopy(
            { scholarshipAckSubject: 'Save your seat in {{programName}} — "Camp Fun"', scholarshipAckMembershipBody: null, scholarshipAckProgramBody: null },
            "program",
            { programName: "Robotics" },
        );
        expect(result.subject).toBe('Save your seat in Robotics — "Camp Fun"');
    });

    it("a configured subject with {{programName}} but no value given falls back to empty string, same as the body", () => {
        const result = resolveAckCopy(
            { scholarshipAckSubject: "Re: {{programName}} request", scholarshipAckMembershipBody: null, scholarshipAckProgramBody: null },
            "membership",
        );
        expect(result.subject).toBe("Re:  request");
    });
});

describe("notifyReviewTeam", () => {
    it("scholarshipNotifyEmail set to a comma-list → sends to both", async () => {
        (prisma.boardSettings.findUnique as jest.Mock).mockResolvedValue({ scholarshipNotifyEmail: "a@x.org, b@x.org" });

        await notifyReviewTeam("Subject", "<p>Body</p>", "err:");

        const sent = __getSentEmails().map((e) => e.to).sort();
        expect(sent).toEqual(["a@x.org", "b@x.org"]);
        expect(prisma.person.findMany).not.toHaveBeenCalled(); // never falls back to board
    });

    it("scholarshipNotifyEmail null → falls back to emailBoardMembers", async () => {
        (prisma.boardSettings.findUnique as jest.Mock).mockResolvedValue({ scholarshipNotifyEmail: null });
        (prisma.person.findMany as jest.Mock).mockResolvedValue([{ email: "board@x.org" }]);

        await notifyReviewTeam("Subject", "<p>Body</p>", "err:");

        expect(prisma.person.findMany).toHaveBeenCalledWith({
            where: { isBoardMember: true, email: { not: null } },
            select: { email: true },
        });
        expect(__getSentEmails().map((e) => e.to)).toEqual(["board@x.org"]);
    });

    it("malformed stored value → falls back to emailBoardMembers", async () => {
        (prisma.boardSettings.findUnique as jest.Mock).mockResolvedValue({ scholarshipNotifyEmail: "not-an-email" });
        (prisma.person.findMany as jest.Mock).mockResolvedValue([{ email: "board@x.org" }]);

        await notifyReviewTeam("Subject", "<p>Body</p>", "err:");

        expect(__getSentEmails().map((e) => e.to)).toEqual(["board@x.org"]);
    });
});
