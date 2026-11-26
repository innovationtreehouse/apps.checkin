/**
 * @jest-environment node
 */
/**
 * Cancelling a receive-queue line needs a reason. Real route, handler and stripper; only the
 * library's database and next-auth are mocked.
 */
import type { NextRequest as NextRequestType } from "next/server";
import { getServerSession } from "next-auth/next";
import { configureLocalInventory } from "@checkin/local-inventory";
import { DELETE as cancelLine } from "@/app/api/inventory/receive-queue/[id]/route";

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>("next/server");
const mockSession = getServerSession as jest.Mock;

const mockTransaction = jest.fn();
jest.mock("@checkin/local-inventory/lib/db", () => ({
  db: { $transaction: (...args: unknown[]) => mockTransaction(...args) },
}));

const manager = { id: 4, email: "manager@x.test", isInventoryManager: true };

function cancel(body: unknown) {
  mockSession.mockResolvedValue({ user: manager });
  const req = new NextRequest("http://localhost/api/inventory/receive-queue/3", { method: "DELETE", body: JSON.stringify(body) });
  return cancelLine(req, { params: Promise.resolve({ id: "3" }) });
}

beforeAll(() => {
  configureLocalInventory({ auth: { getPrincipal: async () => ({ id: 4, name: "Manager" }) }, org: async () => ({ id: "treehouse", name: "Treehouse" }) });
});
beforeEach(() => mockTransaction.mockReset());

describe("DELETE /api/inventory/receive-queue/[id]", () => {
  it.each([
    ["no reason", {}],
    ["a blank reason", { reason: "   " }],
  ])("refuses %s with a 400 and touches no line", async (_, body) => {
    const res = await cancel(body);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/reason/);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
