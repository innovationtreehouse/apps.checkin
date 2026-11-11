/**
 * @jest-environment node
 */
/**
 * The stock and receiving reads return the matching provisional parts, so their pages can name
 * them. Real routes, handler and stripper; only the library's database and next-auth are mocked.
 */
import type { NextRequest as NextRequestType } from "next/server";
import { getServerSession } from "next-auth/next";
import { configureLocalInventory } from "@checkin/local-inventory";
import { GET as listOrgItems } from "@/app/api/inventory/org-items/route";
import { GET as getOrgItem } from "@/app/api/inventory/org-items/[gtin13]/route";
import { GET as listReceiveQueue } from "@/app/api/inventory/receive-queue/route";

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>("next/server");
const mockSession = getServerSession as jest.Mock;

const PROVISIONAL = "0200000000011";
const orgItem = { id: 1, orgId: "treehouse", gtin13: PROVISIONAL, existingQuantity: 2, desiredQuantity: 0, location: null, backstockLocation: null };
const queueLine = { id: 3, orgId: "treehouse", gtin13: PROVISIONAL, quantity: 1, retailer: "Acme", fulfilledAt: null, cancelledAt: null };
const provisional = {
  id: 9, provisionalGtin13: PROVISIONAL, name: "Widget", usageBehavior: "consumable", status: "rejected",
  proposedByUserId: 7, orgId: "treehouse", rejectionReason: "duplicate of an existing part",
};

const mockProvisionalFind = jest.fn();
jest.mock("@checkin/local-inventory/lib/db", () => ({
  db: {
    orgItem: { findMany: async () => [orgItem], findFirst: async () => orgItem },
    receiveQueue: { findMany: async () => [queueLine] },
    inventoryProvisionalItem: { findMany: (...args: unknown[]) => mockProvisionalFind(...args) },
  },
}));

const viewer = { id: 2, email: "viewer@x.test", isActiveOrgMember: true, ageBand: "adult", isProgramVolunteer: true };
const finance = { id: 3, email: "finance@x.test", isFinance: true };

async function read(route: (req: NextRequestType, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>, user: object) {
  mockSession.mockResolvedValue({ user });
  const res = await route(new NextRequest("http://localhost/api/inventory/x"), { params: Promise.resolve({ gtin13: PROVISIONAL }) });
  expect(res.status).toBe(200);
  return res.json();
}

beforeAll(() => {
  configureLocalInventory({ auth: { getPrincipal: async () => null }, org: async () => ({ id: "treehouse", name: "Treehouse" }) });
});
beforeEach(() => mockProvisionalFind.mockReset().mockResolvedValue([provisional]));

describe("provisional part names on the stock and receiving reads", () => {
  it.each([
    ["the org-items list", listOrgItems],
    ["an org item", getOrgItem],
  ])("%s gives a viewer the provisional's public fields only", async (_, route) => {
    const body = await read(route, viewer);
    expect(body.InventoryProvisionalItem).toEqual([{ id: 9, provisionalGtin13: PROVISIONAL, name: "Widget", usageBehavior: "consumable", status: "rejected" }]);
    expect(mockProvisionalFind).toHaveBeenCalledWith(expect.objectContaining({ where: { orgId: "treehouse", provisionalGtin13: { in: [PROVISIONAL] } } }));
  });

  it("the org-items list still carries its rows", async () => {
    expect((await read(listOrgItems, viewer)).OrgItem).toEqual([expect.objectContaining({ gtin13: PROVISIONAL })]);
  });

  it("the receive queue carries its lines and their provisional parts", async () => {
    const body = await read(listReceiveQueue, finance);
    expect(body.ReceiveQueue).toEqual([expect.objectContaining({ id: 3 })]);
    expect(body.InventoryProvisionalItem).toEqual([expect.objectContaining({ provisionalGtin13: PROVISIONAL, name: "Widget" })]);
  });
});
