import prisma from "@/lib/prisma";
import { resolveScholarshipRecipients, notifyReviewTeam, sendScholarshipAck } from "../scholarshipEmails";
import { REGISTRY } from "@/lib/email-templates/registry";

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

        await sendScholarshipAck(recipients, "scholarship.ackMembership", {});

        const sent = __getSentEmails().map((e) => e.to).sort();
        expect(sent).toEqual(["default-on@x.org", "opted-out@x.org"]);
    });

    it("sends the template with its tokens filled, escaping them in the body", async () => {
        await sendScholarshipAck([{ email: "lead@x.org", settings: null }], "scholarship.ackProgram", { programName: "<b>Camp</b>" });

        const [email] = __getSentEmails();
        expect(email.subject).toBe(REGISTRY["scholarship.ackProgram"].defaultSubject);
        expect(email.html).toContain("request for &lt;b&gt;Camp&lt;/b&gt;.");
    });
});

describe("notifyReviewTeam", () => {
    const REVIEW_CTX = { householdId: "42", requestKind: "Payment plan", actionLink: "https://x.org/review" };

    it("scholarshipNotifyEmail set to a comma-list → sends to both", async () => {
        (prisma.boardSettings.findUnique as jest.Mock).mockResolvedValue({ scholarshipNotifyEmail: "a@x.org, b@x.org" });

        await notifyReviewTeam("scholarship.membershipReview", REVIEW_CTX, "err:");

        const sent = __getSentEmails().map((e) => e.to).sort();
        expect(sent).toEqual(["a@x.org", "b@x.org"]);
        expect(prisma.person.findMany).not.toHaveBeenCalled(); // never falls back to board
    });

    it("scholarshipNotifyEmail null → falls back to emailBoardMembers", async () => {
        (prisma.boardSettings.findUnique as jest.Mock).mockResolvedValue({ scholarshipNotifyEmail: null });
        (prisma.person.findMany as jest.Mock).mockResolvedValue([{ email: "board@x.org" }]);

        await notifyReviewTeam("scholarship.membershipReview", REVIEW_CTX, "err:");

        expect(prisma.person.findMany).toHaveBeenCalledWith({
            where: { isBoardMember: true, email: { not: null } },
            select: { email: true },
        });
        expect(__getSentEmails().map((e) => e.to)).toEqual(["board@x.org"]);
    });

    it("malformed stored value → falls back to emailBoardMembers", async () => {
        (prisma.boardSettings.findUnique as jest.Mock).mockResolvedValue({ scholarshipNotifyEmail: "not-an-email" });
        (prisma.person.findMany as jest.Mock).mockResolvedValue([{ email: "board@x.org" }]);

        await notifyReviewTeam("scholarship.membershipReview", REVIEW_CTX, "err:");

        expect(__getSentEmails().map((e) => e.to)).toEqual(["board@x.org"]);
    });
});
