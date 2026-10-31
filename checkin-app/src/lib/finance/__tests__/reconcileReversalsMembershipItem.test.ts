/**
 * @jest-environment node
 */
/**
 * The daily reversal pass judges an activated membership order by its item, never
 * by its total: it raises AMOUNT_MISMATCH only when the membership line is gone.
 */
import type { IncomeMirrorLineRow, MirrorOrder } from "@/lib/shopifyRead/client";

const findProcesses = jest.fn();
const findMemberships = jest.fn();
const ordersByLegacyIds = jest.fn();
const incomeOrderLines = jest.fn();
const orderLineVariantIds = jest.fn();

jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        orgMembershipProcess: { findMany: (...a: unknown[]) => findProcesses(...a) },
        programParticipant: { findMany: async () => [] },
        orgMembership: { findMany: (...a: unknown[]) => findMemberships(...a) },
        membershipYearVariant: { findMany: async () => [] },
        boardSettings: {
            findUnique: async () => ({ orgMembershipVariantId: "variant-membership", orgMembershipYearBoundary: null, volunteerFamilyDiscountCode: "VOLFAM" }),
        },
    },
}));
jest.mock("@/lib/membership/payment", () => ({ activateByProcessId: jest.fn() }));
jest.mock("@/lib/shopifyRead/client", () => ({
    ordersByLegacyIds: (...a: unknown[]) => ordersByLegacyIds(...a),
    disputedOrderGids: async () => new Set<string>(),
    incomeOrderLines: (...a: unknown[]) => incomeOrderLines(...a),
    orderLineVariantIds: (...a: unknown[]) => orderLineVariantIds(...a),
}));
jest.mock("../reconcile/exceptions", () => ({ raisePaymentException: jest.fn(), recordReversal: jest.fn() }));

import { raisePaymentException } from "../reconcile/exceptions";
import { reconcileReversals } from "../reconcile/reversals";

const GID = "gid://shopify/Order/700";

function order(overrides: Partial<MirrorOrder> = {}): MirrorOrder {
    return {
        orderGid: GID,
        legacyId: "700",
        customerEmail: null,
        financialStatus: "PAID",
        totalCents: 5000,
        subtotalCents: 5000,
        totalRefundedCents: 0,
        discountCents: 0,
        discountCodes: [],
        cancelledAt: null,
        processedAt: null,
        updatedAt: new Date(),
        noteAttributes: null,
        ...overrides,
    };
}

function line(variantId: string, currentQuantity: number): IncomeMirrorLineRow {
    return { orderGid: GID, variantId, title: null, sku: null, quantity: 1, currentQuantity, priceCents: 5000, discountCents: 0 };
}

const raisedKinds = () => jest.mocked(raisePaymentException).mock.calls.map(([kind]) => kind);

beforeEach(() => {
    jest.clearAllMocks();
    findProcesses.mockResolvedValue([{ id: 1, shopifyOrderId: "700", orgMembershipId: 2, status: "ACTIVE" }]);
    findMemberships.mockResolvedValue([{ id: 2, isVolunteerFamily: false }]);
    orderLineVariantIds.mockResolvedValue(["variant-membership"]);
    incomeOrderLines.mockResolvedValue([line("variant-membership", 1)]);
});

it("does not flag an uncouponed order carrying the membership item that totals under the fee", async () => {
    ordersByLegacyIds.mockResolvedValue([order({ totalCents: 1000, subtotalCents: 1000 })]);
    await expect(reconcileReversals()).resolves.toBe(0);
    expect(raisePaymentException).not.toHaveBeenCalled();
});

it("does not flag an ordinary couponed order carrying the membership item", async () => {
    ordersByLegacyIds.mockResolvedValue([order({ totalCents: 2000, discountCents: 3000, discountCodes: ["SUMMER26"] })]);
    await reconcileReversals();
    expect(raisePaymentException).not.toHaveBeenCalled();
});

it.each<[string, IncomeMirrorLineRow[]]>([
    ["removed", []],
    ["edited down to zero", [line("variant-membership", 0)]],
    ["swapped for another item", [line("variant-other", 1)]],
])("raises AMOUNT_MISMATCH when the membership line was %s after activation", async (_label, lines) => {
    ordersByLegacyIds.mockResolvedValue([order()]);
    incomeOrderLines.mockResolvedValue(lines);
    await expect(reconcileReversals()).resolves.toBe(1);
    expect(raisePaymentException).toHaveBeenCalledWith("AMOUNT_MISMATCH", { shopifyOrderId: "700", processId: 1 });
});

it("does not judge an order the mirror never showed a membership line on", async () => {
    ordersByLegacyIds.mockResolvedValue([order({ totalCents: 1000, subtotalCents: 1000 })]);
    orderLineVariantIds.mockResolvedValue([]);
    incomeOrderLines.mockResolvedValue([]);
    await reconcileReversals();
    expect(raisePaymentException).not.toHaveBeenCalled();
});

it.each<[string, Partial<MirrorOrder>, string]>([
    ["refunded", { financialStatus: "REFUNDED", totalRefundedCents: 5000 }, "REFUND"],
    ["cancelled", { cancelledAt: new Date() }, "CANCELLED"],
])("raises only %s for a reversed order, whatever its lines", async (_label, overrides, kind) => {
    ordersByLegacyIds.mockResolvedValue([order(overrides)]);
    incomeOrderLines.mockResolvedValue([]);
    await reconcileReversals();
    expect(raisedKinds()).toEqual([kind]);
    expect(incomeOrderLines).not.toHaveBeenCalled();
});

it("still raises DISCOUNT_UNAUTHORIZED for the volunteer code on a non-volunteer order carrying the item", async () => {
    ordersByLegacyIds.mockResolvedValue([order({ totalCents: 2000, discountCents: 3000, discountCodes: ["VOLFAM"] })]);
    await reconcileReversals();
    expect(raisedKinds()).toEqual(["DISCOUNT_UNAUTHORIZED"]);
});
