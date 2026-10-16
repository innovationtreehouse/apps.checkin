/**
 * @jest-environment node
 */
import type { NextRequest as NextRequestType } from "next/server";
import { getServerSession } from "next-auth/next";
import { mailQueueService } from "@inventory/receipt";
import { GET as list } from "../route";
import { POST as assign } from "../[id]/assign/route";
import { POST as discard } from "../[id]/discard/route";
import { GET as file } from "../[id]/file/route";

jest.mock("@inventory/bulk-donation", () => ({ recordReceiptDonorReads: jest.fn() }));
jest.mock("@inventory/receipt", () => ({
  mailQueueService: { listHeld: jest.fn(), assign: jest.fn(), discard: jest.fn(), getFile: jest.fn() },
}));

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>("next/server");
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
const service = jest.mocked(mailQueueService);

/** A ServiceError as the library throws it (matched by name and status). */
const serviceError = (statusCode: number, message: string) => Object.assign(new Error(message), { name: "ServiceError", statusCode });

function signIn(flags: Record<string, boolean | string> = {}) {
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

const req = (path: string, method = "GET", body?: unknown) =>
  new NextRequest(`http://localhost/api/receipts/mail-items${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (id = "3") => ({ params: Promise.resolve({ id }) });
const noParams = { params: Promise.resolve({}) };

const ITEM = {
  id: 3,
  receivedAt: "2026-10-15T00:00:00.000Z",
  senderAddress: "stranger@elsewhere.test",
  status: "held",
  mimeType: "application/pdf",
  receiptId: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSession.mockReset();
});

describe("mail queue routes admit FINANCE only", () => {
  const calls = [
    () => list(req(""), noParams),
    () => assign(req("/3/assign", "POST", { email: "a@example.org" }), params()),
    () => discard(req("/3/discard", "POST", { reason: "spam" }), params()),
    () => file(req("/3/file"), params()),
  ];

  it.each<[string, Record<string, boolean | string>]>([
    ["a board member", { isBoardMember: true }],
    ["a sysadmin", { isSysadmin: true }],
    ["an adult member", { ageBand: "adult", isActiveOrgMember: true }],
  ])("refuses %s on every route without calling the library", async (_who, flags) => {
    for (const call of calls) {
      signIn(flags);
      expect((await call()).status).toBe(403);
    }
    expect(service.listHeld).not.toHaveBeenCalled();
    expect(service.assign).not.toHaveBeenCalled();
    expect(service.discard).not.toHaveBeenCalled();
    expect(service.getFile).not.toHaveBeenCalled();
  });

  it("lists held items with their sender for FINANCE", async () => {
    signIn({ isFinance: true });
    service.listHeld.mockResolvedValue([{ ...ITEM, receivedAt: new Date(ITEM.receivedAt) }]);
    const res = await list(req(""), noParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([ITEM]);
  });
});

describe("assign", () => {
  it("passes the item id and body to the library once and returns the assigned item", async () => {
    signIn({ isFinance: true });
    service.assign.mockResolvedValue({ ...ITEM, receivedAt: new Date(ITEM.receivedAt), status: "assigned", receiptId: "r-1" });
    const res = await assign(req("/3/assign", "POST", { email: "a@example.org" }), params());
    expect(res.status).toBe(200);
    expect(service.assign).toHaveBeenCalledTimes(1);
    expect(service.assign).toHaveBeenCalledWith(3, { email: "a@example.org" });
    expect(await res.json()).toMatchObject({ status: "assigned", receiptId: "r-1" });
  });

  it("answers the library's 403 for a self or household assignment", async () => {
    signIn({ isFinance: true });
    service.assign.mockRejectedValue(serviceError(403, "You cannot assign a receipt to yourself or your household"));
    const res = await assign(req("/3/assign", "POST", { email: "me@example.org" }), params());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/yourself or your household/);
  });

  it("400s a non-integer id without calling the library", async () => {
    signIn({ isFinance: true });
    expect((await assign(req("/x/assign", "POST", { email: "a@example.org" }), params("x"))).status).toBe(400);
    expect(service.assign).not.toHaveBeenCalled();
  });
});

describe("discard", () => {
  it("answers the library's 400 when the reason is missing", async () => {
    signIn({ isFinance: true });
    service.discard.mockRejectedValue(serviceError(400, "A reason is required"));
    const res = await discard(req("/3/discard", "POST", {}), params());
    expect(res.status).toBe(400);
    expect(service.discard).toHaveBeenCalledWith(3, {});
  });

  it("400s a body that is not JSON", async () => {
    signIn({ isFinance: true });
    const bad = new NextRequest("http://localhost/api/receipts/mail-items/3/discard", { method: "POST", body: "nope" });
    expect((await discard(bad, params())).status).toBe(400);
    expect(service.discard).not.toHaveBeenCalled();
  });
});

describe("file", () => {
  it("serves a held PDF to FINANCE with nosniff", async () => {
    signIn({ isFinance: true });
    service.getFile.mockResolvedValue({ id: 3, fileBlob: new Uint8Array([0x25, 0x50, 0x44, 0x46]), mimeType: "application/pdf" });
    const res = await file(req("/3/file"), params());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/pdf");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
