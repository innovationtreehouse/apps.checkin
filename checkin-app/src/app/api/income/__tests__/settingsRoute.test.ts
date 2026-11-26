/**
 * @jest-environment node
 */
/**
 * PATCH /api/income/settings through checkin's handler(): who the registry admits, and the
 * FINANCE and Board roles the route hands the income library from the session. The library is
 * stubbed; its own tests cover the cap rules.
 */
import type { NextRequest as NextRequestType } from "next/server";
import { getServerSession } from "next-auth/next";
import { ServiceError } from "@checkin/component-kit";
import { routes } from "@checkin/income";
import type { AuthenticatedUser } from "@/types/auth";
import { PATCH } from "../settings/route";

jest.mock("@checkin/income", () => ({ routes: { getSettings: jest.fn(), updateSettings: jest.fn() } }));
jest.mock("@/lib/finance/financeViewLog", () => ({
  ...jest.requireActual("@/lib/finance/financeViewLog"),
  recordFinanceViewCall: jest.fn().mockResolvedValue(undefined),
}));

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>("next/server");

const member: Partial<AuthenticatedUser> = {
  id: 5, email: "member@x.test", isSysadmin: false, isBoardMember: false, isFinance: false, programsLed: [], householdId: 7,
};
const SETTINGS = {
  IncomeOrgSettings: { orgId: "org", maxCreatesPerRun: 10, maxCreateCentsPerRun: 2_500_000, benevityMaxCreateCentsPerRun: 2_500_000, benevityMatchWindowDays: 7 },
};

const updateFactory = jest.mocked(routes.updateSettings);
const update = jest.fn();

function patch(user: Partial<AuthenticatedUser>, body: unknown = { maxCreatesPerRun: 10 }) {
  jest.mocked(getServerSession).mockResolvedValueOnce({ user, expires: "2099-01-01T00:00:00.000Z" });
  const req = new NextRequest("http://localhost/api/income/settings", { method: "PATCH", body: JSON.stringify(body) });
  return PATCH(req, { params: Promise.resolve({}) });
}

beforeEach(() => {
  jest.mocked(getServerSession).mockReset();
  update.mockReset().mockResolvedValue(SETTINGS);
  updateFactory.mockReset().mockReturnValue(update);
});

describe("PATCH /api/income/settings", () => {
  it.each<[string, Partial<AuthenticatedUser>, { isFinance: boolean; isBoard: boolean }]>([
    ["FINANCE", { ...member, isFinance: true }, { isFinance: true, isBoard: false }],
    ["the Board", { ...member, isBoardMember: true }, { isFinance: false, isBoard: true }],
    ["FINANCE on the Board", { ...member, isFinance: true, isBoardMember: true }, { isFinance: true, isBoard: true }],
  ])("admits %s and hands the library the session's roles", async (_, user, roles) => {
    const res = await patch(user);
    expect(res.status).toBe(200);
    expect(updateFactory).toHaveBeenCalledWith(roles);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("refuses anyone else before the library runs", async () => {
    expect((await patch(member)).status).toBe(403);
    expect(updateFactory).not.toHaveBeenCalled();
  });

  it("refuses a caller with no session", async () => {
    jest.mocked(getServerSession).mockResolvedValueOnce(null);
    const req = new NextRequest("http://localhost/api/income/settings", { method: "PATCH", body: "{}" });
    expect((await PATCH(req, { params: Promise.resolve({}) })).status).toBe(401);
    expect(updateFactory).not.toHaveBeenCalled();
  });

  it("returns the library's refusal with its status", async () => {
    update.mockRejectedValue(new ServiceError(403, "Raising maxCreatesPerRun takes the board"));
    const res = await patch({ ...member, isFinance: true }, { maxCreatesPerRun: 50 });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "Raising maxCreatesPerRun takes the board" });
  });
});
