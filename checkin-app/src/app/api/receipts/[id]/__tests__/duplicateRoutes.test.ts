/**
 * @jest-environment node
 */
import type { NextRequest as NextRequestType } from "next/server";
import { ServiceError } from "@checkin/component-kit";
import { getServerSession } from "next-auth/next";
import { GET as get } from "../route";
import { POST as clearDuplicate } from "../clear-duplicate/route";
import { POST as discard } from "../discard/route";

jest.mock("@checkin/bulk-donation", () => ({ recordReceiptDonorReads: jest.fn() }));
jest.mock("@checkin/receipt", () => ({
  receiptService: { get: jest.fn(), clearDuplicate: jest.fn(), discard: jest.fn() },
}));

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>("next/server");
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
const service = jest.requireMock<{ receiptService: { get: jest.Mock; clearDuplicate: jest.Mock; discard: jest.Mock } }>("@checkin/receipt").receiptService;

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

const req = (path: string, method = "GET") => new NextRequest(`http://localhost/api/receipts${path}`, { method, body: method === "GET" ? undefined : "{}" });
const params = (id = "r-dup") => ({ params: Promise.resolve({ id }) });

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

describe("POST /api/receipts/[id]/clear-duplicate", () => {
  it("refuses BOARD without calling the library", async () => {
    signIn({ isBoardMember: true });
    expect((await clearDuplicate(req("/r-dup/clear-duplicate", "POST"), params())).status).toBe(403);
    expect(service.clearDuplicate).not.toHaveBeenCalled();
  });

  it("answers the library's conflict-of-interest 403 to FINANCE", async () => {
    signIn({ isFinance: true });
    service.clearDuplicate.mockRejectedValue(new ServiceError(403, "You cannot decide on a receipt that you or your household uploaded or is reimbursed for"));
    const res = await clearDuplicate(req("/r-dup/clear-duplicate", "POST"), params());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/you or your household/);
  });
});

describe("POST /api/receipts/[id]/discard on either receipt of a pair", () => {
  it("runs FINANCE's discard as a submitter, so it reaches only their own receipts", async () => {
    signIn({ isFinance: true });
    service.discard.mockRejectedValue(new ServiceError(404, "Receipt not found"));
    const res = await discard(req("/r-orig/discard", "POST"), params("r-orig"));
    expect(res.status).toBe(404);
    expect(service.discard).toHaveBeenCalledWith("r-orig", "submitter");
  });

  it("runs a BOARD member's discard as a submitter, so it reaches only their own receipts", async () => {
    signIn({ isBoardMember: true, ageBand: "adult", isActiveOrgMember: true });
    service.discard.mockRejectedValue(new ServiceError(404, "Receipt not found"));
    const res = await discard(req("/r-orig/discard", "POST"), params("r-orig"));
    expect(res.status).toBe(404);
    expect(service.discard).toHaveBeenCalledWith("r-orig", "submitter");
  });
});
