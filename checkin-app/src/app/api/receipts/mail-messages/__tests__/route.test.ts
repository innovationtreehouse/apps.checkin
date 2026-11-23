/**
 * @jest-environment node
 */
import type { NextRequest as NextRequestType } from "next/server";
import { getServerSession } from "next-auth/next";
import { mailQueueService } from "@checkin/receipt";
import { GET as list } from "../route";

jest.mock("@/lib/finance/financeViewLog", () => ({
  ...jest.requireActual("@/lib/finance/financeViewLog"),
  recordFinanceViewCall: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@checkin/receipt/services/mailQueueService", () => ({ mailQueueService: { listUnprocessed: jest.fn() } }));

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>("next/server");
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
const service = jest.mocked(mailQueueService);

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

const call = () => list(new NextRequest("http://localhost/api/receipts/mail-messages"), { params: Promise.resolve({}) });

const LISTED = [
  { id: 3, receivedAt: "2026-08-01T09:00:00.000Z", capturedAt: "2026-08-01T09:05:00.000Z", expired: true },
  { id: 7, receivedAt: "2026-11-20T09:00:00.000Z", capturedAt: "2026-11-20T09:05:00.000Z", expired: false },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockSession.mockReset();
});

describe("GET /api/receipts/mail-messages", () => {
  it("lists FINANCE the captured emails as id, times and expired, dropping the key, error and every other column", async () => {
    signIn({ isFinance: true });
    service.listUnprocessed.mockResolvedValue(
      LISTED.map((row) =>
        Object.assign(
          { ...row, receivedAt: new Date(row.receivedAt), capturedAt: new Date(row.capturedAt) },
          { rawKey: `mail-raw/${row.id}.eml`, processError: "system: no amount from jane@example.com", gmailMessageId: "18c2f0a1b2", rawSha256: "ab12", orgId: "org-1" },
        ),
      ),
    );
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(LISTED);
  });

  it.each<[string, Record<string, boolean | string>]>([
    ["a board member", { isBoardMember: true }],
    ["a sysadmin", { isSysadmin: true }],
    ["an adult member", { ageBand: "adult", isActiveOrgMember: true }],
    ["a person with no role", {}],
  ])("refuses %s without calling the library", async (_who, flags) => {
    signIn(flags);
    expect((await call()).status).toBe(403);
    expect(service.listUnprocessed).not.toHaveBeenCalled();
  });

  it("401s a signed-out caller", async () => {
    mockSession.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    expect(service.listUnprocessed).not.toHaveBeenCalled();
  });
});
