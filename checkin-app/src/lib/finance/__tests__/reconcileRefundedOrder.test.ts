/**
 * @jest-environment node
 */
/**
 * The forward pass must recognise a refunded membership order after a re-payment
 * has overwritten the process's shopifyOrderId: the refund's audit row keeps it.
 */
import type { MirrorOrder } from "@/lib/shopifyRead/client";

jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        orgMembershipProcess: { findFirst: jest.fn(), findUnique: jest.fn() },
        auditLog: { findFirst: jest.fn() },
    },
}));
jest.mock("@/lib/membership/payment", () => ({ activateByProcessId: jest.fn() }));
jest.mock("@/lib/shopifyRead/client", () => ({
    orderAttr: (o: MirrorOrder, key: string) => o.noteAttributes?.find((a) => a.key === key)?.value ?? null,
}));
jest.mock("../reconcile/exceptions", () => ({ raisePaymentException: jest.fn() }));

import prisma from "@/lib/prisma";
import { raisePaymentException } from "../reconcile/exceptions";
import { reconcileForwardMembership } from "../reconcile/membership";

it("does not raise a refunded order whose id a later payment overwrote", async () => {
    // Paid with order-1, refunded, paid with order-2, refunded again: the process is back at PENDING_PAYMENT holding order-2.
    jest.mocked(prisma.orgMembershipProcess.findFirst).mockResolvedValue(null);
    jest.mocked(prisma.orgMembershipProcess.findUnique).mockResolvedValue(
        { id: 5, status: "PENDING_PAYMENT", orgMembershipId: 9 } as Awaited<ReturnType<typeof prisma.orgMembershipProcess.findUnique>>,
    );
    jest.mocked(prisma.auditLog.findFirst).mockResolvedValue({ id: 1 } as Awaited<ReturnType<typeof prisma.auditLog.findFirst>>);
    const order = {
        legacyId: "order-1",
        financialStatus: "REFUNDED",
        cancelledAt: null,
        totalRefundedCents: 10000,
        noteAttributes: [{ key: "Membership_Process_ID", value: "5" }],
    } as unknown as MirrorOrder;

    await expect(reconcileForwardMembership(order)).resolves.toBe(true);
    expect(prisma.auditLog.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
            oldData: { path: ["shopifyOrderId"], equals: "order-1" },
            newData: { path: ["refundRecorded"], equals: true },
        }),
    }));
    expect(raisePaymentException).not.toHaveBeenCalled();
});
