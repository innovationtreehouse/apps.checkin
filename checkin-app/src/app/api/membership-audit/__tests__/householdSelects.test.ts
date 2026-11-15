/**
 * @jest-environment node
 *
 * The membership-audit household lists select only the household and lead columns
 * their pages show, so a household's address and intake note are never read.
 */
import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import { GET as complianceGET } from "@/app/api/membership-audit/compliance/route";
import { GET as missingContactGET } from "@/app/api/membership-audit/households-missing-contact/route";
import { GET as unclaimedGET } from "@/app/api/membership-audit/unclaimed-households/route";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/emergencyContacts/service", () => ({
    ...jest.requireActual("@/lib/emergencyContacts/service"),
    findHouseholdsMissingValidContact: jest.fn().mockResolvedValue([10]),
}));

const householdFindMany = jest.fn();
const revokedFindMany = jest.fn();
// Every other query answers empty: the compliance route reaches its household read
// with one REVOKED household and nothing else.
jest.mock("@/lib/prisma", () => {
    const emptyModel = new Proxy({}, { get: (_t, method) => async () => (String(method) === "findMany" ? [] : null) });
    const models: Record<string, unknown> = {
        household: { findMany: (...a: unknown[]) => householdFindMany(...a) },
        orgMembership: { findMany: (...a: unknown[]) => revokedFindMany(...a) },
    };
    return { __esModule: true, default: new Proxy(models, { get: (t, model: string) => t[model] ?? emptyModel }) };
});

const LEAD = { id: 2, name: "Lead", phone: "5550000", email: "lead@example.com", lastBackgroundCheck: null };

const req = (path: string) => new Request(`http://localhost${path}`, { headers: { cookie: "x=1" } }) as unknown as NextRequest;
const sortedKeys = (o: object) => Object.keys(o).sort();

beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getServerSession).mockResolvedValue({ user: { id: 99, isBoardMember: true } });
    revokedFindMany.mockImplementation(async (args: { where: { status: unknown } }) =>
        typeof args.where.status === "object" ? [{ householdId: 10, status: "REVOKED" }] : []);
    householdFindMany.mockResolvedValue([{ id: 10, name: "Smith", householdMembers: [LEAD] }]);
});

describe("GET /api/membership-audit/compliance", () => {
    it("selects the household's id, name and lead columns", async () => {
        expect((await complianceGET(req("/api/membership-audit/compliance"))).status).toBe(200);

        const args = householdFindMany.mock.calls[0][0];
        expect(args).not.toHaveProperty("include");
        expect(sortedKeys(args.select)).toEqual(["householdMembers", "id", "name"]);
        expect(sortedKeys(args.select.householdMembers.select)).toEqual(["email", "id", "lastBackgroundCheck", "name", "phone"]);
    });

    it("ships each household with the fields the compliance page reads", async () => {
        const body = await (await complianceGET(req("/api/membership-audit/compliance"))).json();

        expect(sortedKeys(body.households[0])).toEqual(["id", "lastBackgroundCheck", "leads", "name", "reasons"]);
        expect(body.households[0].reasons).toEqual(["REVOKED"]);
    });
});

describe("GET /api/membership-audit/households-missing-contact", () => {
    it("selects the household's id, name and lead contact columns", async () => {
        const res = await missingContactGET(req("/api/membership-audit/households-missing-contact"));
        expect(res.status).toBe(200);

        const args = householdFindMany.mock.calls[0][0];
        expect(args).not.toHaveProperty("include");
        expect(sortedKeys(args.select)).toEqual(["householdMembers", "id", "name"]);
        expect(sortedKeys(args.select.householdMembers.select)).toEqual(["email", "id", "name", "phone"]);
        expect(sortedKeys((await res.json()).households[0])).toEqual(["id", "leads", "name"]);
    });
});

describe("GET /api/membership-audit/unclaimed-households", () => {
    it("selects the household's id, name and each member's id, name and email", async () => {
        const res = await unclaimedGET(req("/api/membership-audit/unclaimed-households"));
        expect(res.status).toBe(200);

        const args = householdFindMany.mock.calls[0][0];
        expect(args).not.toHaveProperty("include");
        expect(sortedKeys(args.select)).toEqual(["householdMembers", "id", "name"]);
        expect(args.select.householdMembers).toEqual({ select: { id: true, name: true, email: true } });
        expect((await res.json()).households).toEqual([{ id: 10, name: "Smith", members: [{ id: 2, name: "Lead", email: "lead@example.com" }] }]);
    });
});
