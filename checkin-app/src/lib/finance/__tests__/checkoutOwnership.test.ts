/**
 * @jest-environment node
 */
/**
 * The daily reconciler activates a program order's children only when the order
 * carries a checkout signature their own household's checkout made; any other
 * order is raised as UNMATCHED_ORDER and activates nobody.
 */
import type { MirrorOrder } from "@/lib/shopifyRead/client";

jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("@/lib/membership/payment", () => ({ activateByProcessId: jest.fn() }));
jest.mock("@/lib/membership/boardAlerts", () => ({ notifyBoardPaymentException: jest.fn() }));
jest.mock("@/lib/shopify/stock", () => ({ adjustProgramInventory: jest.fn() }));
jest.mock("@/lib/programs/memberDiscountCode", () => ({ unentitledMemberCodeUse: jest.fn().mockResolvedValue(false) }));
jest.mock("@/lib/programs/activateEnrollment", () => ({ activateProgramEnrollment: jest.fn().mockResolvedValue({ activatedCount: 1 }) }));
jest.mock("@/lib/logger", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/shopifyRead/client", () => ({
    isConfigured: () => true,
    orderAttr: (o: MirrorOrder, key: string) => o.noteAttributes?.find((a) => a.key === key)?.value ?? null,
    ordersChangedSince: jest.fn(),
    orderLines: jest.fn().mockResolvedValue([{ variantId: "V1", quantity: 1, currentQuantity: 1 }]),
    ordersByLegacyIds: jest.fn().mockResolvedValue([]),
    disputedOrderGids: jest.fn().mockResolvedValue(new Set()),
}));

import prisma from "@/lib/prisma";
import * as mirror from "@/lib/shopifyRead/client";
import { activateProgramEnrollment } from "@/lib/programs/activateEnrollment";
import { signCheckout } from "@/lib/programs/checkoutSignature";
import { runReconcile } from "../reconcile";

const PROGRAM = 7;
const CHILD = 41;
const OWN_HOUSEHOLD = 3;
const OTHER_HOUSEHOLD = 9;

const activate = activateProgramEnrollment as jest.Mock;
const exceptionCreate = jest.fn().mockResolvedValue({ id: 1 });
const childHouseholds = jest.fn();

function order(sig: string | null): MirrorOrder {
    const noteAttributes = [
        { key: "CheckMeIn_Account_ID", value: String(CHILD) },
        { key: "Program_ID", value: String(PROGRAM) },
        ...(sig ? [{ key: "CheckMeIn_Checkout_Sig", value: sig }] : []),
    ];
    return {
        orderGid: "gid://shopify/Order/900", legacyId: "900", customerEmail: null, financialStatus: "PAID",
        totalCents: 5000, subtotalCents: 5000, totalRefundedCents: 0, discountCents: 0, discountCodes: [],
        processedAt: null, cancelledAt: null, updatedAt: new Date("2026-10-16T09:00:00Z"), noteAttributes,
    };
}

const prevSecret = process.env.NEXTAUTH_SECRET;
beforeAll(() => { process.env.NEXTAUTH_SECRET = "checkout-ownership-test"; });
afterAll(() => {
    if (prevSecret === undefined) delete process.env.NEXTAUTH_SECRET; else process.env.NEXTAUTH_SECRET = prevSecret;
});

beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(prisma, {
        boardSettings: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() },
        orgMembershipProcess: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
        programParticipant: { findFirst: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(1), findMany: jest.fn().mockResolvedValue([]) },
        person: { findMany: childHouseholds },
        auditLog: { findMany: jest.fn().mockResolvedValue([]) },
        program: { findUnique: jest.fn().mockResolvedValue({ shopifyVariantId: "V1", claimantShopifyVariantId: null }) },
        paymentException: { findFirst: jest.fn().mockResolvedValue(null), create: exceptionCreate },
    });
});

async function reconcile(o: MirrorOrder, householdOfChild: number) {
    childHouseholds.mockResolvedValue([{ householdId: householdOfChild }]);
    (mirror.ordersChangedSince as jest.Mock).mockResolvedValue([o]);
    const result = await runReconcile();
    expect(result.failed).toBe(0);
}

const raisedKinds = () => exceptionCreate.mock.calls.map((c) => c[0].data.kind);

describe("runReconcile — program checkout ownership", () => {
    it("activates a child named by their own household's signed checkout", async () => {
        await reconcile(order(signCheckout(PROGRAM, [CHILD], OWN_HOUSEHOLD)), OWN_HOUSEHOLD);
        expect(activate).toHaveBeenCalledWith(expect.objectContaining({ programId: PROGRAM, personIds: [CHILD] }));
        expect(raisedKinds()).toEqual([]);
    });

    it("raises and activates nobody when the child belongs to another household", async () => {
        await reconcile(order(signCheckout(PROGRAM, [CHILD], OWN_HOUSEHOLD)), OTHER_HOUSEHOLD);
        expect(activate).not.toHaveBeenCalled();
        expect(raisedKinds()).toEqual(["UNMATCHED_ORDER"]);
    });

    it("raises and activates nobody when the order carries no signature", async () => {
        await reconcile(order(null), OWN_HOUSEHOLD);
        expect(activate).not.toHaveBeenCalled();
        expect(raisedKinds()).toEqual(["UNMATCHED_ORDER"]);
    });
});
