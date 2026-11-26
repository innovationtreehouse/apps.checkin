/**
 * @jest-environment node
 *
 * The Board's certify names the membership year the payment is for: required, a whole
 * number, and one the grant action may record. A year other than the application's own
 * goes through only with the acknowledgement.
 */
import type { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { certifyPaymentPlan } from "@/lib/membership/payment";
import { POST } from "../route";

jest.mock("@/lib/auth", () => ({
    withAuth: (_o: unknown, h: (req: unknown, auth: unknown) => unknown) =>
        (req: unknown) => h(req, { type: "session", user: { id: 3, isSysadmin: false, isBoardMember: true } }),
}));
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: { boardSettings: { findUnique: jest.fn() } } }));
jest.mock("@/lib/membership/payment", () => ({
    ...jest.requireActual("@/lib/membership/payment"),
    certifyPaymentPlan: jest.fn().mockResolvedValue({ id: 7, status: "ACTIVE" }),
}));

const post = (body: unknown) => (POST as unknown as (req: NextRequest) => Promise<Response>)(
    new Request("http://localhost/api/membership-ops/applications/certify-payment", { method: "POST", body: JSON.stringify(body) }) as unknown as NextRequest,
);

beforeEach(() => {
    jest.clearAllMocks();
    // Boundary 1 Sep; 10 Jul 2026 is inside the 2026-2027 renewal window, so 2025 and 2026 are grantable.
    jest.useFakeTimers({ now: new Date(Date.UTC(2026, 6, 10, 12)), doNotFake: ["nextTick", "queueMicrotask", "setImmediate", "setTimeout"] });
    jest.mocked(prisma.boardSettings.findUnique).mockResolvedValue({ orgMembershipYearBoundary: new Date(Date.UTC(2000, 8, 1)) } as never);
});
afterEach(() => jest.useRealTimers());

it.each([
    ["no year", { processId: 7, reason: "paid by check" }],
    ["a year that is not a whole number", { processId: 7, reason: "paid by check", year: 2025.5 }],
    ["a year given as text", { processId: 7, reason: "paid by check", year: "2025" }],
])("refuses %s with a 400, certifying nothing", async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "Choose the membership year this payment is for." });
    expect(certifyPaymentPlan).not.toHaveBeenCalled();
});

it("refuses a year the grant action may not record", async () => {
    expect((await post({ processId: 7, reason: "paid by check", year: 2024 })).status).toBe(400);
    expect(certifyPaymentPlan).not.toHaveBeenCalled();
});

it("certifies the named year, passing the acknowledgement only when it is true", async () => {
    expect((await post({ processId: 7, reason: "paid by check", year: 2026, acknowledgeYearMismatch: true })).status).toBe(200);
    expect(certifyPaymentPlan).toHaveBeenLastCalledWith(7, 3, { reason: "paid by check", year: 2026, acknowledgeYearMismatch: true });

    await post({ processId: 7, reason: "paid by check", year: 2025, acknowledgeYearMismatch: "yes" });
    expect(certifyPaymentPlan).toHaveBeenLastCalledWith(7, 3, { reason: "paid by check", year: 2025, acknowledgeYearMismatch: false });
});
