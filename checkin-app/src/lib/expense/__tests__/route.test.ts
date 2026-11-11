/**
 * @jest-environment node
 */
import type { NextRequest as NextRequestType } from "next/server";
import type { ExpenseRouteCtx } from "@checkin/expense";
import { expenseRoute } from "@/lib/expense/route";
import type { HandlerContext } from "@/security/handler";
import type { AuthResult, AuthenticatedUser } from "@/types/auth";

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>("next/server");

const req = new NextRequest("http://localhost/api/expense/expenses/e-1");
const params = { id: "e-1" };
const ctx = (auth: AuthResult): HandlerContext => ({ req, params, auth, role: "authenticated" });
const session = (user: Partial<AuthenticatedUser>): AuthResult => ({ type: "session", user: { id: 5, ...user } as AuthenticatedUser });

describe("expenseRoute", () => {
  const factory = jest.fn<Promise<Record<string, unknown>>, [ExpenseRouteCtx]>();

  beforeEach(() => factory.mockReset().mockResolvedValue({ Expense: [] }));

  it("hands the factory the caller as a principal", async () => {
    await expect(expenseRoute(factory)(ctx(session({ name: "Pat", isFinance: true, isBoardMember: false })))).resolves.toEqual({ Expense: [] });
    expect(factory).toHaveBeenCalledWith({ req, params, principal: { id: 5, name: "Pat", isFinance: true, isBoard: false } });
  });

  it("maps a missing name and absent role flags to null and false", async () => {
    await expenseRoute(factory)(ctx(session({})));
    expect(factory.mock.calls[0][0].principal).toEqual({ id: 5, name: null, isFinance: false, isBoard: false });
  });

  it.each<[string, AuthResult]>([
    ["an unauthenticated caller", { type: "unauthenticated" }],
    ["a kiosk", { type: "kiosk" }],
  ])("refuses %s with a 401 before the library runs", async (_who, auth) => {
    await expect(expenseRoute(factory)(ctx(auth))).rejects.toMatchObject({ status: 401 });
    expect(factory).not.toHaveBeenCalled();
  });
});
