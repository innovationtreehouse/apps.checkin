/**
 * @jest-environment node
 */
import prisma from "@/lib/prisma";
import { listCurrentMembers, membersToCsv } from "@/lib/membership/currentMembers";

jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: { boardSettings: { findUnique: jest.fn() }, person: { findMany: jest.fn() } },
}));

const NOW = new Date("2026-11-27T12:00:00Z");
const row = (email: string, settled: boolean, over: object = {}) => ({
    email,
    name: email.split("@")[0],
    household: { orgMembership: { processes: settled ? [{ id: 1 }] : [] } },
    ...over,
});

beforeEach(() => {
    jest.mocked(prisma.boardSettings.findUnique).mockResolvedValue({ orgMembershipYearBoundary: new Date("2020-08-01T00:00:00Z") } as never);
});

describe("listCurrentMembers", () => {
    it("drops a lapsed ACTIVE household and keeps a paid live-year one, with its horizon", async () => {
        jest.mocked(prisma.person.findMany).mockResolvedValue([row("lapsed@x.org", false), row("paid@x.org", true)] as never);
        const members = await listCurrentMembers(NOW);
        expect(members.map((m) => m.email)).toEqual(["paid@x.org"]);
        expect(members[0].validThrough?.toISOString().slice(0, 10)).toBe("2027-08-01");
    });

    it("keeps everyone ACTIVE when no year boundary is set", async () => {
        jest.mocked(prisma.boardSettings.findUnique).mockResolvedValue(null as never);
        jest.mocked(prisma.person.findMany).mockResolvedValue([row("a@x.org", false)] as never);
        expect((await listCurrentMembers(NOW)).map((m) => m.validThrough)).toEqual([null]);
    });

    it("asks only for ACTIVE memberships in live households with an email", async () => {
        jest.mocked(prisma.person.findMany).mockResolvedValue([] as never);
        await listCurrentMembers(NOW);
        const { where } = jest.mocked(prisma.person.findMany).mock.calls[0][0] as { where: object };
        expect(JSON.stringify(where)).toContain('"archivedAt":null');
        expect(JSON.stringify(where)).toContain('"status":"ACTIVE"');
        expect(where).toMatchObject({ email: { not: null } });
    });
});

describe("membersToCsv", () => {
    it("quotes cells, and defuses formulas", () => {
        const csv = membersToCsv([
            { email: "a@x.org", name: 'Ann "A", Lee', validThrough: new Date("2027-08-01T00:00:00Z") },
            { email: "b@x.org", name: "=HYPERLINK(\"evil\")", validThrough: null },
            { email: "c@x.org", name: null, validThrough: null },
        ]);
        expect(csv.split("\r\n")).toEqual([
            "email,name,validThrough",
            '"a@x.org","Ann ""A"", Lee","2027-08-01"',
            `"b@x.org","'=HYPERLINK(""evil"")",""`,
            '"c@x.org","",""',
            "",
        ]);
    });
});
