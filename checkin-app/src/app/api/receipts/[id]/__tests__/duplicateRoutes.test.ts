/**
 * @jest-environment node
 */
import type { NextRequest as NextRequestType } from "next/server";
import { ServiceError } from "@checkin/component-kit";
import { getServerSession } from "next-auth/next";
import { GET as get } from "../route";
import { GET as getGroup } from "../duplicate-group/route";
import { POST as notThisOne } from "../not-this-one/route";
import { DELETE as undoNotThisOne } from "../not-this-one/[otherId]/route";
import { POST as differentPurchases } from "../different-purchases/route";
import { POST as keepThisOne } from "../keep-this-one/route";

jest.mock("@checkin/bulk-donation", () => ({ recordReceiptDonorReads: jest.fn() }));
jest.mock("@checkin/receipt", () => ({
  receiptService: {
    get: jest.fn(),
    duplicateGroup: jest.fn(),
    notThisOne: jest.fn(),
    undoNotThisOne: jest.fn(),
    differentPurchases: jest.fn(),
    keepThisOne: jest.fn(),
  },
}));

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>("next/server");
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
type Service = Record<"get" | "duplicateGroup" | "notThisOne" | "undoNotThisOne" | "differentPurchases" | "keepThisOne", jest.Mock>;
const service = jest.requireMock<{ receiptService: Service }>("@checkin/receipt").receiptService;

function signIn(flags: Record<string, boolean | string | number> = {}) {
  mockSession.mockResolvedValue({
    user: {
      id: 5,
      isSysadmin: false,
      isBoardMember: false,
      isKeyholder: false,
      isBackgroundCheckReviewer: false,
      isOperations: false,
      isInventoryManager: false,
      isFinance: false,
      ...flags,
    },
    expires: "2099-01-01",
  });
}

const req = (path: string, method = "GET", body: unknown = {}) =>
  new NextRequest(`http://localhost/api/receipts${path}`, { method, body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body) });
const params = (id = "r-dup") => ({ params: Promise.resolve({ id }) });
const GROUP = {
  members: [
    { id: "r-orig", state: "rejected", label: "Rejected on 2 Oct: personal purchase" },
    { id: "r-dup", state: "duplicate_flagged", label: "Possible duplicate" },
  ],
  dismissed: ["r-other"],
};

const FLAGGED = {
  id: "r-dup",
  uploadedByUserId: 7,
  uploadedAt: "2026-10-02T00:00:00.000Z",
  fileHash: "abc123",
  mimeType: "application/pdf",
  retailer: "Acme",
  receiptDate: "2026-10-01",
  receiptTotalCents: 1000,
  state: "duplicate_flagged",
  duplicateSuspectReceiptId: "r-orig",
  lineItems: [{ id: 1, receiptId: "r-dup", description: "Arduino", quantity: 1, unitPriceCents: 1000, totalPriceCents: 1000 }],
  financialReviewReasons: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSession.mockReset();
});

describe("GET /api/receipts/[id] gives the compare what it reads", () => {
  it.each<[string, Record<string, boolean>]>([
    ["FINANCE", { isFinance: true }],
    ["BOARD", { isBoardMember: true }],
  ])("returns %s the suspect id, the file hash and the lines", async (_who, flags) => {
    signIn(flags);
    service.get.mockResolvedValue(FLAGGED);
    const res = await get(req("/r-dup"), params());
    expect(res.status).toBe(200);
    expect(service.get).toHaveBeenCalledWith("r-dup", "finance");
    expect(await res.json()).toMatchObject({
      duplicateSuspectReceiptId: "r-orig",
      fileHash: "abc123",
      lineItems: [{ description: "Arduino", totalPriceCents: 1000 }],
    });
  });

  it("keeps the suspect id off the uploader's own view", async () => {
    signIn({ id: 7, ageBand: "adult", isActiveOrgMember: true });
    service.get.mockResolvedValue(FLAGGED);
    const res = await get(req("/r-dup"), params());
    expect(res.status).toBe(200);
    expect(service.get).toHaveBeenCalledWith("r-dup", "submitter");
    const body = await res.json();
    expect(body).not.toHaveProperty("duplicateSuspectReceiptId");
    expect(body.state).toBe("duplicate_flagged");
  });
});

describe("GET /api/receipts/[id]/duplicate-group", () => {
  it.each<[string, Record<string, boolean>]>([
    ["FINANCE", { isFinance: true }],
    ["BOARD", { isBoardMember: true }],
  ])("returns %s every member with its label, and the dismissed ids", async (_who, flags) => {
    signIn(flags);
    service.duplicateGroup.mockResolvedValue(GROUP);
    const res = await getGroup(req("/r-dup/duplicate-group"), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(GROUP);
  });

  it("refuses the uploader without calling the library", async () => {
    signIn({ id: 7, ageBand: "adult", isActiveOrgMember: true });
    expect((await getGroup(req("/r-dup/duplicate-group"), params())).status).toBe(403);
    expect(service.duplicateGroup).not.toHaveBeenCalled();
  });
});

describe("the duplicate decisions", () => {
  const decisions = [
    ["not-this-one", () => notThisOne(req("/r-dup/not-this-one", "POST", { otherId: "r-orig" }), params())],
    ["undo", () => undoNotThisOne(req("/r-dup/not-this-one/r-orig", "DELETE"), { params: Promise.resolve({ id: "r-dup", otherId: "r-orig" }) })],
    ["different-purchases", () => differentPurchases(req("/r-dup/different-purchases", "POST", { shownIds: ["r-orig", "r-dup"] }), params())],
    ["keep-this-one", () => keepThisOne(req("/r-dup/keep-this-one", "POST", { shownIds: ["r-orig", "r-dup"] }), params())],
  ] as const;

  it.each(decisions)("%s refuses BOARD without calling the library", async (_name, call) => {
    signIn({ isBoardMember: true });
    expect((await call()).status).toBe(403);
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it("passes the pair to the library and returns the fresh group", async () => {
    signIn({ isFinance: true });
    service.notThisOne.mockResolvedValue(GROUP);
    service.undoNotThisOne.mockResolvedValue(GROUP);
    expect(await (await decisions[0][1]()).json()).toEqual(GROUP);
    expect(service.notThisOne).toHaveBeenCalledWith("r-dup", "r-orig");
    expect(await (await decisions[1][1]()).json()).toEqual(GROUP);
    expect(service.undoNotThisOne).toHaveBeenCalledWith("r-dup", "r-orig");
  });

  it("passes the shown ids to the group-wide decisions", async () => {
    signIn({ isFinance: true });
    service.differentPurchases.mockResolvedValue(FLAGGED);
    service.keepThisOne.mockResolvedValue(FLAGGED);
    expect((await decisions[2][1]()).status).toBe(200);
    expect(service.differentPurchases).toHaveBeenCalledWith("r-dup", ["r-orig", "r-dup"]);
    expect((await decisions[3][1]()).status).toBe(200);
    expect(service.keepThisOne).toHaveBeenCalledWith("r-dup", ["r-orig", "r-dup"]);
  });

  it("answers 400 to a group-wide decision without the shown ids", async () => {
    signIn({ isFinance: true });
    expect((await differentPurchases(req("/r-dup/different-purchases", "POST", {}), params())).status).toBe(400);
    expect(service.differentPurchases).not.toHaveBeenCalled();
  });

  it("answers the library's 409 for a stale group, with its message", async () => {
    signIn({ isFinance: true });
    service.keepThisOne.mockRejectedValue(new ServiceError(409, "A new possible copy arrived after you opened this: Acme, 1 Oct, $10.00"));
    const res = await decisions[3][1]();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/new possible copy/);
  });

  it("answers the library's conflict-of-interest 403 to FINANCE", async () => {
    signIn({ isFinance: true });
    service.differentPurchases.mockRejectedValue(new ServiceError(403, "You cannot decide on a receipt that you or your household uploaded or is reimbursed for"));
    const res = await decisions[2][1]();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/you or your household/);
  });
});
