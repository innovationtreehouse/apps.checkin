/**
 * @jest-environment node
 *
 * Who may resolve an attendance conflict: the Board and sysadmins (any visit)
 * and the lead of the owning program (their own event's visit). A keyholder
 * is neither, so is refused.
 */
import type { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { POST } from "@/app/api/my-programs/conflicts/resolve/route";

let mockUser: Record<string, unknown>;
jest.mock("@/lib/auth", () => ({
  withAuth: (_opts: unknown, handler: (req: NextRequest, auth: unknown) => unknown) =>
    (req: NextRequest) => handler(req, { type: "session", user: mockUser }),
}));
jest.mock("@/lib/getFullAttendance", () => ({ invalidateAttendanceCache: jest.fn() }));

const tx = {
  $executeRaw: jest.fn(),
  visit: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  auditLog: { create: jest.fn() },
};
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    visit: { findUnique: jest.fn() },
    $transaction: jest.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
  },
}));

const LEAD_ID = 5;
const visit = {
  id: 42, personId: 9, deletedAt: null,
  arrivedAt: new Date("2026-07-20T14:00:00Z"), departedAt: new Date("2026-07-20T16:00:00Z"),
  arrivedVia: "WEB", departedVia: "WEB", associatedEventId: 3,
  event: { program: { leadMentorId: LEAD_ID } },
};
const sibling = { arrivedAt: new Date("2026-07-20T15:00:00Z"), departedAt: new Date("2026-07-20T17:00:00Z") };

const call = () => POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ visitId: 42 }) }) as NextRequest, undefined as never);

beforeEach(() => {
  jest.clearAllMocks();
  (prisma.visit.findUnique as jest.Mock).mockResolvedValue(visit);
  tx.visit.findUnique.mockResolvedValue(visit);
  tx.visit.findMany.mockResolvedValue([sibling]);
});

describe("POST /api/my-programs/conflicts/resolve authorization", () => {
  it("refuses a keyholder who does not lead the program", async () => {
    mockUser = { id: 99, isKeyholder: true };
    const res = await call();
    expect(res.status).toBe(403);
    expect(tx.visit.update).not.toHaveBeenCalled();
  });

  it.each([["board", { isBoardMember: true }], ["sysadmin", { isSysadmin: true }]])("lets %s resolve", async (_n, flags) => {
    mockUser = { id: 99, ...flags };
    const res = await call();
    expect(res.status).toBe(200);
    expect(tx.visit.update).toHaveBeenCalled();
  });

  it("lets the owning program's lead resolve, even if also a keyholder", async () => {
    mockUser = { id: LEAD_ID, isKeyholder: true };
    expect((await call()).status).toBe(200);
  });

  it("refuses a lead of some other program", async () => {
    mockUser = { id: 77 };
    expect((await call()).status).toBe(403);
  });
});
