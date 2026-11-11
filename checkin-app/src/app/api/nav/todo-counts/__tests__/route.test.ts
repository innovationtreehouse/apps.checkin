/**
 * @jest-environment node
 */
import { getServerSession } from "next-auth/next";
import { todoCounts, type TodoCounts } from "@/lib/nav/todoCounts";
import { GET } from "@/app/api/nav/todo-counts/route";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/verify-kiosk", () => ({
    getKioskPublicKeys: jest.fn().mockReturnValue([]),
    verifyKioskSignature: jest.fn().mockReturnValue({ ok: false }),
}));
jest.mock("@/lib/nav/todoCounts", () => ({ todoCounts: jest.fn() }));

const counts = {
    member: { household: [], programs: [], programsAwaitingFinance: 0 },
    building: 2,
    buildingHousehold: 0,
    buildingReachable: true,
    activePrograms: 1,
} as TodoCounts;

const callAs = (user: { id: number; householdId: number } | null) => {
    (getServerSession as jest.Mock).mockResolvedValue(user === null ? null : { user });
    return GET(new Request("http://localhost:4000/api/nav/todo-counts", { method: "GET" }));
};

describe("GET /api/nav/todo-counts", () => {
    beforeEach(() => (todoCounts as jest.Mock).mockResolvedValue(counts));

    it("returns the counts with the id of the person they were read for", async () => {
        const res = await callAs({ id: 42, householdId: 7 });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ...counts, personId: 42 });
        expect(todoCounts).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }));
    });

    it("returns 401 without a session", async () => {
        const res = await callAs(null);
        expect(res.status).toBe(401);
    });
});
