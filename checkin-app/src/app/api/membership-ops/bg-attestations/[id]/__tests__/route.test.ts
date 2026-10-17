/**
 * @jest-environment node
 *
 * Unit tests (mocked prisma) for the two concurrency-safety details a real
 * Postgres transaction can't cheaply pin: that the delete takes the
 * OrgMembershipProcess FOR UPDATE lock (attest()'s contract) BEFORE
 * removing the attestation, and that a concurrent double-delete's P2025
 * maps to 404 rather than falling to the generic 500. 400/404/success/audit
 * and the merge-unblock scenario are covered against real Postgres in
 * route.integration.test.ts.
 */
import { getServerSession } from "next-auth/next";
import { DELETE } from "../route";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/verify-kiosk", () => ({
    getKioskPublicKeys: jest.fn().mockReturnValue([]),
    verifyKioskSignature: jest.fn().mockReturnValue({ ok: false }),
}));

const tx = {
    backgroundCheckAttestation: { findUnique: jest.fn(), delete: jest.fn() },
    auditLog: { create: jest.fn() },
    $queryRaw: jest.fn(),
};
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: { $transaction: jest.fn(async (cb: (t: unknown) => unknown) => cb(tx)) },
}));

const mockSession = getServerSession as jest.Mock;
const attestation = {
    id: 42, processId: 7, reviewerId: 1, subjectPersonId: null,
    result: "APPROVE", note: null, isMarkedVolunteerFamily: false, createdAt: new Date("2026-08-01T00:00:00Z"),
};

function req(body?: unknown) {
    return new Request("http://localhost/api/membership-ops/bg-attestations/42", {
        method: "DELETE",
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }) as unknown as import("next/server").NextRequest;
}
const ctx = { params: Promise.resolve({ id: "42" }) };

beforeEach(() => {
    jest.clearAllMocks();
    mockSession.mockResolvedValue({ user: { id: 99, isBoardMember: true } });
    tx.backgroundCheckAttestation.findUnique.mockResolvedValue(attestation);
    tx.backgroundCheckAttestation.delete.mockResolvedValue(attestation);
    tx.auditLog.create.mockResolvedValue({});
});

it("locks the attestation's process row (FOR UPDATE) before deleting it", async () => {
    const res = await DELETE(req({ reason: "dup identity" }), ctx);
    expect(res.status).toBe(200);

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    // Tagged-template call: second arg is the first interpolated value.
    expect(tx.$queryRaw.mock.calls[0][1]).toBe(attestation.processId);
    expect(tx.$queryRaw.mock.invocationCallOrder[0])
        .toBeLessThan(tx.backgroundCheckAttestation.delete.mock.invocationCallOrder[0]);
});

it("maps a concurrent double-delete's P2025 to 404, and writes no audit row", async () => {
    tx.backgroundCheckAttestation.delete.mockRejectedValue({ code: "P2025" });

    const res = await DELETE(req({ reason: "dup identity" }), ctx);

    expect(res.status).toBe(404);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
});
