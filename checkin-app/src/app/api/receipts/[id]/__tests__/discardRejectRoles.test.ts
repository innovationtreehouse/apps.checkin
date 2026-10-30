/**
 * @jest-environment node
 */
import type { NextRequest as NextRequestType } from "next/server";
import { ServiceError } from "@checkin/component-kit";
import { getServerSession } from "next-auth/next";
import { POST as discard } from "../discard/route";
import { POST as reject } from "../reject/route";

jest.mock("@checkin/receipt", () => ({
  receiptService: { discard: jest.fn(), rejectFinancial: jest.fn() },
}));

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>("next/server");
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
const service = jest.requireMock<{ receiptService: { discard: jest.Mock; rejectFinancial: jest.Mock } }>("@checkin/receipt").receiptService;

const MEMBER = { ageBand: "adult", isActiveOrgMember: true };

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

const post = (path: string, body: unknown = {}) =>
  new NextRequest(`http://localhost/api/receipts${path}`, { method: "POST", body: JSON.stringify(body) });
const params = { params: Promise.resolve({ id: "r-1" }) };
const ROW = { id: "r-1", uploadedByUserId: 5, state: "discarded", lineItems: [], financialReviewReasons: [] };

beforeEach(() => {
  jest.clearAllMocks();
  mockSession.mockReset();
});

describe("POST /api/receipts/[id]/discard", () => {
  it("discards the uploader's own receipt", async () => {
    signIn(MEMBER);
    service.discard.mockResolvedValue(ROW);
    expect((await discard(post("/r-1/discard"), params)).status).toBe(200);
    expect(service.discard).toHaveBeenCalledWith("r-1", "submitter");
  });

  it("runs FINANCE's discard as a submitter, so another person's receipt is not found", async () => {
    signIn({ ...MEMBER, isFinance: true });
    service.discard.mockRejectedValue(new ServiceError(404, "Receipt not found"));
    expect((await discard(post("/r-1/discard"), params)).status).toBe(404);
    expect(service.discard).toHaveBeenCalledWith("r-1", "submitter");
  });

  it("runs the Board's discard as a submitter, so another person's receipt is not found", async () => {
    signIn({ ...MEMBER, isBoardMember: true });
    service.discard.mockRejectedValue(new ServiceError(404, "Receipt not found"));
    expect((await discard(post("/r-1/discard"), params)).status).toBe(404);
    expect(service.discard).toHaveBeenCalledWith("r-1", "submitter");
  });
});

describe("POST /api/receipts/[id]/reject", () => {
  it("rejects for FINANCE with the reason", async () => {
    signIn({ isFinance: true });
    service.rejectFinancial.mockResolvedValue({ ...ROW, state: "rejected" });
    expect((await reject(post("/r-1/reject", { reason: "personal purchase" }), params)).status).toBe(200);
    expect(service.rejectFinancial).toHaveBeenCalledWith("r-1", "personal purchase");
  });

  it.each<[string, unknown]>([
    ["no reason", {}],
    ["a null reason", { reason: null }],
    ["a blank reason", { reason: "   " }],
  ])("refuses FINANCE with %s", async (_what, body) => {
    signIn({ isFinance: true });
    expect((await reject(post("/r-1/reject", body), params)).status).toBe(400);
    expect(service.rejectFinancial).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, boolean | string>]>([
    ["the Board", { ...MEMBER, isBoardMember: true }],
    ["the uploader", MEMBER],
  ])("refuses %s without calling the library", async (_who, flags) => {
    signIn(flags);
    expect((await reject(post("/r-1/reject", { reason: "x" }), params)).status).toBe(403);
    expect(service.rejectFinancial).not.toHaveBeenCalled();
  });
});
