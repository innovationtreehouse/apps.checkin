/**
 * @jest-environment node
 */
/**
 * Matrix test for the Shopify reconciler (lib/finance/reconcile/). Real app DB,
 * mocked `shopify_read` mirror (fixtures) — so every taxonomy row is exercised
 * against real membership/program state without needing a second Postgres. Each
 * assertion also re-runs to prove idempotency (no double activation, no duplicate
 * PaymentException).
 */
import prisma from "@/lib/prisma";
import { snapshotBoardSettings } from "@/test-helpers/boardSettings";
import { runReconcile } from "@/lib/finance/reconcile";
import { raiseReversalByOrderId, returnTestOrderStock } from "@/lib/finance/reconcile/reversals";
import { orderEntitlesEnrollment, type EntitlementOrder } from "@/lib/finance/reconcile/program";
import { activateProgramEnrollment } from "@/lib/programs/activateEnrollment";
import { systemActor } from "@/lib/auditActor";
import type { IncomeMirrorLineRow, MirrorOrder } from "@/lib/shopifyRead/client";

jest.mock("@/lib/email", () => ({
    sendEmail: jest.fn().mockResolvedValue(true),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));

// Mocked mirror — each test sets what the read helpers return. Only the DB-backed
// reads are stubbed; orderAttr stays REAL (it's a pure parse of the mirrored
// note_attributes, and the tests should exercise the real thing).
jest.mock("@/lib/shopifyRead/client", () => ({
    ...jest.requireActual("@/lib/shopifyRead/client"),
    isConfigured: () => true,
    ordersChangedSince: jest.fn(async () => [] as MirrorOrder[]),
    ordersByLegacyIds: jest.fn(async () => [] as MirrorOrder[]),
    disputedOrderGids: jest.fn(async () => new Set<string>()),
    // Each test starts with the membership variant on the order (see beforeEach).
    orderLineVariantIds: jest.fn(),
    orderLines: jest.fn(async () => [] as { variantId: string; quantity: number; currentQuantity: number }[]),
    // Default [] = no mirrored line evidence, so the under-seated check judges nothing.
    incomeOrderLines: jest.fn(async () => [] as IncomeMirrorLineRow[]),
}));
import * as mirror from "@/lib/shopifyRead/client";
jest.mock("@/lib/shopify/stock", () => ({
    ...jest.requireActual("@/lib/shopify/stock"),
    adjustProgramInventory: jest.fn(async () => true),
    changeProgramStockWith: jest.fn((...a: unknown[]) => jest.requireActual('@/test-helpers/stockWith').forwardStockWith(...a)),
}));
import { adjustProgramInventory } from "@/lib/shopify/stock";

const TAG = "reconcile-matrix-test";
// A membership variant id the board has configured; #1048 mirrors it onto order lines.
const MEMBERSHIP_VARIANT = "variant-normal-1";
const ordersChangedSince = mirror.ordersChangedSince as jest.Mock;
const ordersByLegacyIds = mirror.ordersByLegacyIds as jest.Mock;
const disputedOrderGids = mirror.disputedOrderGids as jest.Mock;
const orderLineVariantIds = mirror.orderLineVariantIds as jest.Mock;
const orderLines = mirror.orderLines as jest.Mock;
const incomeOrderLines = mirror.incomeOrderLines as jest.Mock;
const adjustInventory = adjustProgramInventory as jest.Mock;

function order(overrides: Partial<MirrorOrder> & { legacyId: string }): MirrorOrder {
    return {
        orderGid: `gid://shopify/Order/${overrides.legacyId}`,
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
        // Default null = an order synced before #1029, i.e. the email-fallback path.
        // Tests of the preferred path pass noteAttributes explicitly.
        noteAttributes: null,
        ...overrides,
    };
}

/** Cart attributes as the mirror stores them (#1029). */
const attrs = (o: Record<string, string>) => Object.entries(o).map(([key, value]) => ({ key, value }));

/** A household whose lead has `email`, an OrgMembership, and one process. */
async function makeApplicant(opts: {
    email: string;
    status: "PENDING_PAYMENT" | "ACTIVE" | "BLOCKED" | "ARCHIVED";
    household?: "NONE" | "DENIED";
    bgCleared?: boolean;
    isVolunteerFamily?: boolean;
    shopifyOrderId?: string;
    paid?: boolean;
}): Promise<{ householdId: number; processId: number; membershipId: number }> {
    const hh = await prisma.household.create({ data: { name: `HH ${TAG} ${opts.email}` } });
    await prisma.person.create({
        data: { email: opts.email, name: `Lead ${opts.email}`, isHouseholdLead: true, householdId: hh.id },
    });
    const m = await prisma.orgMembership.create({
        data: { householdId: hh.id, status: opts.household ?? (opts.status === "ACTIVE" ? "ACTIVE" : "NONE"), isVolunteerFamily: !!opts.isVolunteerFamily },
    });
    const proc = await prisma.orgMembershipProcess.create({
        data: {
            orgMembershipId: m.id,
            kind: "INITIAL",
            status: opts.status,
            bgClearedAt: opts.bgCleared ? new Date() : null,
            shopifyOrderId: opts.shopifyOrderId ?? null,
            paidAt: opts.paid ? new Date() : null,
        },
    });
    return { householdId: hh.id, processId: proc.id, membershipId: m.id };
}

// The board-configured volunteer-rate coupon (BoardSettings.volunteerFamilyDiscountCode).
// Distinct from the "VOLUNTEER50" promo-style code other cases use, which must stay
// unregistered-as-volunteer so they exercise the codes-are-Shopify's-business path.
const VOLUNTEER_CODE = "VOLFAM";

/**
 * A household with one lead Person enrolled in one Program, mirroring the shape
 * `unentitledMemberCodeUse` needs: a Program with dates (so `programCoverageDate`
 * yields a real through-date), a Household, and a ProgramParticipant at the given
 * status. `membership` seeds an OrgMembership at that status — REVOKED is the
 * deactivated household (beforeAll pins `orgMembershipYearBoundary` to null, so
 * an ACTIVE one covers any date).
 */
async function makeProgramEnrollment(opts: {
    email: string;
    status: "PENDING" | "ACTIVE";
    membership?: "ACTIVE" | "REVOKED";
    shopifyOrderId?: string;
}): Promise<{ householdId: number; personId: number; programId: number; variantId: string }> {
    const hh = await prisma.household.create({ data: { name: `HH ${TAG} ${opts.email}` } });
    const person = await prisma.person.create({
        data: { email: opts.email, name: `Lead ${opts.email}`, isHouseholdLead: true, householdId: hh.id },
    });
    if (opts.membership) {
        await prisma.orgMembership.create({ data: { householdId: hh.id, status: opts.membership } });
    }
    const variantId = `variant-prg-${opts.email}`;
    const program = await prisma.program.create({
        data: { appliesToYear: 2026, name: `Program ${TAG} ${opts.email}`, startAt: new Date("2026-06-01"), endAt: new Date("2026-08-01"), shopifyVariantId: variantId },
    });
    await prisma.programParticipant.create({
        data: { programId: program.id, personId: person.id, status: opts.status, shopifyOrderId: opts.shopifyOrderId ?? null },
    });
    return { householdId: hh.id, personId: person.id, programId: program.id, variantId };
}

let restoreBoardSettings: () => Promise<void> = async () => {};

beforeAll(async () => {
    restoreBoardSettings = await snapshotBoardSettings();
    await prisma.boardSettings.upsert({
        where: { id: 1 },
        create: { id: 1, standardMembershipFeeCents: 5000, volunteerMembershipFeeCents: 2000, orgMembershipVariantId: MEMBERSHIP_VARIANT, volunteerFamilyDiscountCode: VOLUNTEER_CODE, orgMembershipYearBoundary: null },
        update: { standardMembershipFeeCents: 5000, volunteerMembershipFeeCents: 2000, orgMembershipVariantId: MEMBERSHIP_VARIANT, volunteerFamilyDiscountCode: VOLUNTEER_CODE, orgMembershipYearBoundary: null, shopifyReconcileCursorAt: null },
    });
});

beforeEach(() => {
    orderLineVariantIds.mockResolvedValue([MEMBERSHIP_VARIANT]);
});

afterEach(async () => {
    ordersChangedSince.mockResolvedValue([]);
    ordersByLegacyIds.mockResolvedValue([]);
    disputedOrderGids.mockResolvedValue(new Set());
    orderLines.mockResolvedValue([]);
    incomeOrderLines.mockResolvedValue([]);
    adjustInventory.mockClear();
    // Reset cursor so each test scans its own fixtures from scratch.
    await prisma.boardSettings.update({ where: { id: 1 }, data: { shopifyReconcileCursorAt: null } });
});

afterAll(async () => {
    const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const ids = hhs.map((h) => h.id);
    if (ids.length) {
        const procs = await prisma.orgMembershipProcess.findMany({ where: { orgMembership: { householdId: { in: ids } } }, select: { id: true } });
        await prisma.paymentException.deleteMany({ where: { processId: { in: procs.map((p) => p.id) } } });
        await prisma.auditLog.deleteMany({ where: { tableName: "OrgMembershipProcess", affectedEntityId: { in: procs.map((p) => p.id) } } });
        await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: ids } } } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
    }

    const programs = await prisma.program.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const programIds = programs.map((p) => p.id);
    if (programIds.length) {
        await prisma.paymentException.deleteMany({ where: { programId: { in: programIds } } });
        await prisma.auditLog.deleteMany({ where: { actorSystem: { in: ["webhook:shopify-refund", "webhook:shopify-order"] }, secondaryAffectedEntity: { in: programIds } } });
        await prisma.programParticipant.deleteMany({ where: { programId: { in: programIds } } });
        await prisma.program.deleteMany({ where: { id: { in: programIds } } });
    }

    if (ids.length) {
        await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.paymentException.deleteMany({ where: { shopifyOrderId: { startsWith: `${TAG}-` } } });
    await prisma.auditLog.deleteMany({ where: { tableName: "ShopifyOrderReversal", newData: { path: ["shopifyOrderId"], string_starts_with: `${TAG}-` } } });
    await restoreBoardSettings();
});

describe("forward recovery", () => {
    it("recovers a missed payment, advancing PENDING_PAYMENT past the paid checkpoint", async () => {
        const email = `recover-${TAG}@ex.com`;
        const oid = `${TAG}-100`;
        const { processId } = await makeApplicant({ email, status: "PENDING_PAYMENT", bgCleared: true });
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, customerEmail: email, totalCents: 5000 })]);

        const r1 = await runReconcile();
        expect(r1.configured).toBe(true);
        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(proc?.status).toBe("ACTIVE");
        expect(proc?.paidAt).toBeTruthy();
        expect(proc?.shopifyOrderId).toBe(oid);
        // No exception for a clean recovery.
        expect(await prisma.paymentException.count({ where: { processId } })).toBe(0);

        // Idempotent: second run does nothing new (order now recorded on the process).
        await runReconcile();
        expect(await prisma.paymentException.count({ where: { processId } })).toBe(0);
    });

    it("recovers a missed paid-while-blocked webhook: records the payment and raises PAID_WHILE_BLOCKED", async () => {
        const oid = `${TAG}-blocked`;
        const { processId } = await makeApplicant({ email: `blocked-${TAG}@ex.com`, status: "BLOCKED" });
        orderLineVariantIds.mockResolvedValue([MEMBERSHIP_VARIANT]);
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, noteAttributes: attrs({ Membership_Process_ID: String(processId) }) })]);

        await runReconcile();
        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(proc?.status).toBe("BLOCKED");
        expect(proc?.shopifyOrderId).toBe(oid);
        expect(await prisma.paymentException.count({ where: { kind: "PAID_WHILE_BLOCKED", shopifyOrderId: oid, processId } })).toBe(1);
        await runReconcile();
        expect(await prisma.paymentException.count({ where: { shopifyOrderId: oid } })).toBe(1);
    });

    it.each([
        ["a closed application", "ARCHIVED", false],
        ["a second order on an already-paid application", "ACTIVE", true],
    ] as const)("raises a paid order on %s instead of ignoring it", async (_label, status, paid) => {
        const oid = `${TAG}-nothing-due-${status}`;
        const { processId } = await makeApplicant({ email: `nothing-due-${status}-${TAG}@ex.com`, status, paid, shopifyOrderId: paid ? `${TAG}-first` : undefined });
        orderLineVariantIds.mockResolvedValue([MEMBERSHIP_VARIANT]);
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, noteAttributes: attrs({ Membership_Process_ID: String(processId) }) })]);

        await runReconcile();
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: processId } }))?.status).toBe(status);
        expect(await prisma.paymentException.count({ where: { kind: "UNMATCHED_ORDER", shopifyOrderId: oid, processId } })).toBe(1);
    });

    it("never activates a DENIED household: nothing changes", async () => {
        const oid = `${TAG}-denied`;
        const { processId, membershipId } = await makeApplicant({ email: `denied-${TAG}@ex.com`, status: "PENDING_PAYMENT", household: "DENIED", bgCleared: true });
        orderLineVariantIds.mockResolvedValue([MEMBERSHIP_VARIANT]);
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, noteAttributes: attrs({ Membership_Process_ID: String(processId) }) })]);

        await runReconcile();
        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(proc?.status).toBe("PENDING_PAYMENT");
        expect(proc?.paidAt).toBeNull();
        expect((await prisma.orgMembership.findUnique({ where: { id: membershipId } }))?.status).toBe("DENIED");
    });

    it("raises a paid order on a paid application of a DENIED household as DENIED activity, not UNMATCHED_ORDER", async () => {
        const oid = `${TAG}-denied-paid`;
        const { processId } = await makeApplicant({ email: `denied-paid-${TAG}@ex.com`, status: "ACTIVE", household: "DENIED", paid: true, shopifyOrderId: `${TAG}-denied-first` });
        orderLineVariantIds.mockResolvedValue([MEMBERSHIP_VARIANT]);
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, noteAttributes: attrs({ Membership_Process_ID: String(processId) }) })]);

        await runReconcile();
        expect(await prisma.paymentException.count({ where: { kind: "DENIED_HOUSEHOLD_ACTIVITY", processId, severity: "CRITICAL" } })).toBe(1);
        expect(await prisma.paymentException.count({ where: { kind: "UNMATCHED_ORDER", shopifyOrderId: oid } })).toBe(0);
        await runReconcile();
        expect(await prisma.paymentException.count({ where: { processId } })).toBe(1);
    });

    it("finds the Board's recorded refund of an order by its JSON audit row on this process only", async () => {
        const oid = `${TAG}-refund-recorded`;
        const refundedOrder = { legacyId: oid, financialStatus: "REFUNDED", totalRefundedCents: 5000 };
        // Paid with oid, Board recorded the refund, paid again: the process is back awaiting with oid gone from it.
        const recorded = await makeApplicant({ email: `refund-recorded-${TAG}@ex.com`, status: "PENDING_PAYMENT" });
        const other = await makeApplicant({ email: `refund-other-${TAG}@ex.com`, status: "PENDING_PAYMENT" });
        await prisma.auditLog.create({
            data: {
                ...systemActor("system:dev-seed"),
                action: "EDIT",
                tableName: "OrgMembershipProcess",
                affectedEntityId: recorded.processId,
                oldData: { status: "PENDING_BG_CLEARANCE", shopifyOrderId: oid },
                newData: { status: "PENDING_PAYMENT", paidAt: null, refundRecorded: true },
            },
        });
        ordersChangedSince.mockResolvedValue([
            order({ ...refundedOrder, noteAttributes: attrs({ Membership_Process_ID: String(recorded.processId) }) }),
        ]);
        await runReconcile();
        expect(await prisma.paymentException.count({ where: { processId: recorded.processId } })).toBe(0);

        // The same order id attributed to another process is not covered by that row.
        ordersChangedSince.mockResolvedValue([
            order({ ...refundedOrder, noteAttributes: attrs({ Membership_Process_ID: String(other.processId) }) }),
        ]);
        await runReconcile();
        expect(await prisma.paymentException.count({ where: { kind: "REVERSED_BEFORE_ACTIVATION", processId: other.processId } })).toBe(1);
    });

    // An order whose pass throws is isolated (the sweep goes on) but counted: the
    // cron ledger reads `failed`, so a pass that recovered nothing is not a green run.
    it("counts an order whose forward pass throws", async () => {
        const email = `boom-${TAG}@ex.com`;
        await makeApplicant({ email, status: "PENDING_PAYMENT", bgCleared: true });
        ordersChangedSince.mockResolvedValue([order({ legacyId: `${TAG}-boom`, customerEmail: email })]);
        orderLineVariantIds.mockRejectedValue(new Error("mirror read failed"));

        const logged = jest.spyOn(console, "error").mockImplementation(() => {});
        try {
            const r = await runReconcile();
            expect(r.ordersScanned).toBe(1);
            expect(r.failed).toBe(1);
            expect(logged).toHaveBeenCalled();
        } finally {
            logged.mockRestore();
        }
    });

    it("holds at PENDING_BG_CLEARANCE when bg not cleared", async () => {
        const email = `hold-${TAG}@ex.com`;
        const { processId } = await makeApplicant({ email, status: "PENDING_PAYMENT", bgCleared: false });
        ordersChangedSince.mockResolvedValue([order({ legacyId: `${TAG}-101`, customerEmail: email })]);
        await runReconcile();
        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(proc?.status).toBe("PENDING_BG_CLEARANCE");
        expect(proc?.paidAt).toBeTruthy();
    });

    it("the forward pass recovers an order carrying the membership item whatever it totals", async () => {
        const email = `short-${TAG}@ex.com`;
        const oid = `${TAG}-102`;
        const { processId } = await makeApplicant({ email, status: "PENDING_PAYMENT", bgCleared: true });
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, customerEmail: email, totalCents: 1000 })]);
        await runReconcile();
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: processId } }))?.status).toBe("ACTIVE");
        expect(await prisma.paymentException.count({ where: { processId } })).toBe(0);
    });

    it("recovers a couponed order below the gross membership fee (variant match), no AMOUNT_MISMATCH", async () => {
        // #1048: the volunteer rate / promos are Shopify coupons, so a valid order's
        // total is below the gross membership fee. It carries a known membership variant line → recover.
        const email = `coupon-${TAG}@ex.com`;
        const oid = `${TAG}-120`;
        const { processId } = await makeApplicant({ email, status: "PENDING_PAYMENT", bgCleared: true });
        orderLineVariantIds.mockResolvedValue([MEMBERSHIP_VARIANT]);
        ordersChangedSince.mockResolvedValue([
            order({ legacyId: oid, customerEmail: email, totalCents: 2000, discountCents: 3000, discountCodes: ["VOLUNTEER50"] }),
        ]);
        await runReconcile();
        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(proc?.status).toBe("ACTIVE");
        expect(proc?.shopifyOrderId).toBe(oid);
        expect(await prisma.paymentException.count({ where: { kind: "AMOUNT_MISMATCH", processId } })).toBe(0);
    });

    it("raises DISCOUNT_UNAUTHORIZED and does not activate when a NON-volunteer family used the volunteer code", async () => {
        // The #1074 regression: variant gate passes (real membership product), amounts
        // are Shopify's business — but the family isn't entitled to the volunteer rate.
        const email = `volcode-${TAG}@ex.com`;
        const oid = `${TAG}-123`;
        const { processId } = await makeApplicant({ email, status: "PENDING_PAYMENT", bgCleared: true, isVolunteerFamily: false });
        orderLineVariantIds.mockResolvedValue([MEMBERSHIP_VARIANT]);
        ordersChangedSince.mockResolvedValue([
            // Lowercase on the order — Shopify codes are case-insensitive.
            order({ legacyId: oid, customerEmail: email, totalCents: 2000, discountCents: 3000, discountCodes: ["volfam"] }),
        ]);
        await runReconcile();
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: processId } }))?.status).toBe("PENDING_PAYMENT");
        expect(await prisma.paymentException.count({ where: { kind: "DISCOUNT_UNAUTHORIZED", shopifyOrderId: oid } })).toBe(1);

        // Idempotent: a second run does not duplicate the exception.
        await runReconcile();
        expect(await prisma.paymentException.count({ where: { kind: "DISCOUNT_UNAUTHORIZED", shopifyOrderId: oid } })).toBe(1);
    });

    it("activates a volunteer family using the volunteer code, no exception", async () => {
        const email = `volok-${TAG}@ex.com`;
        const oid = `${TAG}-124`;
        const { processId } = await makeApplicant({ email, status: "PENDING_PAYMENT", bgCleared: true, isVolunteerFamily: true });
        orderLineVariantIds.mockResolvedValue([MEMBERSHIP_VARIANT]);
        ordersChangedSince.mockResolvedValue([
            order({ legacyId: oid, customerEmail: email, totalCents: 2000, discountCents: 3000, discountCodes: [VOLUNTEER_CODE] }),
        ]);
        await runReconcile();
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: processId } }))?.status).toBe("ACTIVE");
        expect(await prisma.paymentException.count({ where: { processId } })).toBe(0);
    });

    it("stamps the year of the variant's row, whatever the live year is", async () => {
        const email = `yearrow-${TAG}@ex.com`;
        const oid = `${TAG}-130`;
        const { processId } = await makeApplicant({ email, status: "PENDING_PAYMENT", bgCleared: true });
        await prisma.membershipYearVariant.create({ data: { membershipYear: 2031, shopifyVariantId: `${TAG}-v2031` } });
        orderLineVariantIds.mockResolvedValue([`${TAG}-v2031`]);
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, customerEmail: email })]);
        try {
            await runReconcile();
        } finally {
            await prisma.membershipYearVariant.delete({ where: { membershipYear: 2031 } });
        }
        expect(await prisma.orgMembershipProcess.findUnique({ where: { id: processId } })).toMatchObject({ status: "ACTIVE", appliesToYear: 2031 });
    });

    it("stamps the single variant with the live year when the order was paid, not when it was found", async () => {
        const email = `yearpaid-${TAG}@ex.com`;
        const oid = `${TAG}-131`;
        const { processId } = await makeApplicant({ email, status: "PENDING_PAYMENT", bgCleared: true });
        await prisma.boardSettings.update({ where: { id: 1 }, data: { orgMembershipYearBoundary: new Date(Date.UTC(2000, 8, 1)) } });
        orderLineVariantIds.mockResolvedValue([MEMBERSHIP_VARIANT]);
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, customerEmail: email, processedAt: new Date(Date.UTC(2024, 5, 20)) })]);
        try {
            await runReconcile();
        } finally {
            await prisma.boardSettings.update({ where: { id: 1 }, data: { orgMembershipYearBoundary: null } });
        }
        expect(await prisma.orgMembershipProcess.findUnique({ where: { id: processId } })).toMatchObject({ status: "ACTIVE", appliesToYear: 2023 });
    });

    it("raises NO_ITEM when a variant-mirrored order contains no membership product", async () => {
        const email = `noitem-${TAG}@ex.com`;
        const oid = `${TAG}-121`;
        const { processId } = await makeApplicant({ email, status: "PENDING_PAYMENT", bgCleared: true });
        // Order lines are mirrored, but none is a membership variant (e.g. a t-shirt).
        orderLineVariantIds.mockResolvedValue(["variant-tshirt-99"]);
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, customerEmail: email, totalCents: 5000 })]);
        await runReconcile();
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: processId } }))?.status).toBe("PENDING_PAYMENT");
        expect(await prisma.paymentException.findFirst({ where: { kind: "NO_ITEM", shopifyOrderId: oid } })).toBeTruthy();
    });

    it("raises NO_ITEM and does not activate an order of only custom or deleted products that covers the fee", async () => {
        const email = `customonly-${TAG}@ex.com`;
        const oid = `${TAG}-122`;
        const { processId } = await makeApplicant({ email, status: "PENDING_PAYMENT", bgCleared: true });
        // Custom and deleted-product lines carry no variant id, so none is mirrored.
        orderLineVariantIds.mockResolvedValue([]);
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, customerEmail: email, totalCents: 5000 })]);
        await runReconcile();
        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(proc?.status).toBe("PENDING_PAYMENT");
        expect(proc?.paidAt).toBeNull();
        expect(await prisma.paymentException.findMany({ where: { processId }, select: { kind: true, shopifyOrderId: true } })).toEqual([{ kind: "NO_ITEM", shopifyOrderId: oid }]);
    });

    it("prefers the Membership_Process_ID cart attribute over the email heuristic", async () => {
        const email = `attr-${TAG}@ex.com`;
        const oid = `${TAG}-110`;
        const { processId } = await makeApplicant({ email, status: "PENDING_PAYMENT", bgCleared: true });
        // No customer email on the order at all — the attribute alone must carry it.
        ordersChangedSince.mockResolvedValue([
            order({ legacyId: oid, customerEmail: null, noteAttributes: attrs({ Membership_Process_ID: String(processId) }) }),
        ]);
        await runReconcile();
        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(proc?.status).toBe("ACTIVE");
        expect(proc?.shopifyOrderId).toBe(oid);
    });

    it("attribute disambiguates what email alone could not (two pending processes)", async () => {
        const email = `attrambig-${TAG}@ex.com`;
        const oid = `${TAG}-111`;
        const a = await makeApplicant({ email, status: "PENDING_PAYMENT", bgCleared: true });
        const second = await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: a.membershipId, kind: "RENEWAL", status: "PENDING_PAYMENT", bgClearedAt: new Date() },
        });
        // Email-only would raise UNMATCHED_ORDER here; the attribute names the process.
        ordersChangedSince.mockResolvedValue([
            order({ legacyId: oid, customerEmail: email, noteAttributes: attrs({ Membership_Process_ID: String(second.id) }) }),
        ]);
        await runReconcile();
        expect(await prisma.paymentException.findFirst({ where: { kind: "UNMATCHED_ORDER", shopifyOrderId: oid } })).toBeNull();
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: second.id } }))?.status).toBe("ACTIVE");
        // The sibling is untouched — the money was credited to exactly one process.
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: a.processId } }))?.status).toBe("PENDING_PAYMENT");
    });

    it("raises UNMATCHED_ORDER when the attribute names a process that does not exist", async () => {
        const oid = `${TAG}-112`;
        ordersChangedSince.mockResolvedValue([
            order({ legacyId: oid, noteAttributes: attrs({ Membership_Process_ID: "99999999" }) }),
        ]);
        await runReconcile();
        expect(await prisma.paymentException.findFirst({ where: { kind: "UNMATCHED_ORDER", shopifyOrderId: oid } })).toBeTruthy();
    });

    it("raises UNMATCHED_ORDER when the family has more than one pending process", async () => {
        const email = `ambig-${TAG}@ex.com`;
        const oid = `${TAG}-103`;
        const a = await makeApplicant({ email, status: "PENDING_PAYMENT", bgCleared: true });
        // A second PENDING_PAYMENT process on the SAME membership (email is @unique, so
        // ambiguity comes from two live processes for one family, not two households).
        await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: a.membershipId, kind: "RENEWAL", status: "PENDING_PAYMENT", bgClearedAt: new Date() },
        });
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, customerEmail: email })]);
        await runReconcile();
        expect(await prisma.paymentException.findFirst({ where: { kind: "UNMATCHED_ORDER", shopifyOrderId: oid } })).toBeTruthy();
        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: a.processId } });
        expect(proc?.status).toBe("PENDING_PAYMENT");
    });

    it("ignores a paid order from an email with no pending membership (normal purchase)", async () => {
        ordersChangedSince.mockResolvedValue([order({ legacyId: `${TAG}-104`, customerEmail: `nobody-${TAG}@ex.com` })]);
        const before = await prisma.paymentException.count();
        await runReconcile();
        expect(await prisma.paymentException.count()).toBe(before);
    });

    it("raises REVERSED_BEFORE_ACTIVATION for a refunded order matching a pending process", async () => {
        const email = `prerev-${TAG}@ex.com`;
        const oid = `${TAG}-105`;
        const { processId } = await makeApplicant({ email, status: "PENDING_PAYMENT", bgCleared: true });
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, customerEmail: email, financialStatus: "REFUNDED", totalRefundedCents: 5000 })]);
        await runReconcile();
        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(proc?.status).toBe("PENDING_PAYMENT");
        expect(await prisma.paymentException.findFirst({ where: { kind: "REVERSED_BEFORE_ACTIVATION", shopifyOrderId: oid } })).toBeTruthy();
    });
});

describe("reversal detection", () => {
    it("raises REFUND for a refunded order on an ACTIVE membership, leaving it ACTIVE", async () => {
        const oid = `${TAG}-200`;
        const { processId } = await makeApplicant({ email: `ref-${TAG}@ex.com`, status: "ACTIVE", paid: true, shopifyOrderId: oid });
        ordersByLegacyIds.mockResolvedValue([order({ legacyId: oid, financialStatus: "REFUNDED", totalRefundedCents: 5000 })]);

        await runReconcile();
        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(proc?.status).toBe("ACTIVE"); // never auto-reverted
        expect(await prisma.paymentException.count({ where: { kind: "REFUND", processId } })).toBe(1);

        // Idempotent: a second run does not duplicate the exception.
        await runReconcile();
        expect(await prisma.paymentException.count({ where: { kind: "REFUND", processId } })).toBe(1);
    });

    it("raises CHARGEBACK (critical) when a dispute balance-txn exists", async () => {
        const oid = `${TAG}-201`;
        const { processId } = await makeApplicant({ email: `cb-${TAG}@ex.com`, status: "ACTIVE", paid: true, shopifyOrderId: oid });
        const o = order({ legacyId: oid, financialStatus: "PAID" });
        ordersByLegacyIds.mockResolvedValue([o]);
        disputedOrderGids.mockResolvedValue(new Set([o.orderGid]));

        await runReconcile();
        const ex = await prisma.paymentException.findFirst({ where: { kind: "CHARGEBACK", processId } });
        expect(ex?.severity).toBe("CRITICAL");
    });

    it("does not raise AMOUNT_MISMATCH on a couponed order below the gross membership fee (post-activation)", async () => {
        // ACTIVE membership paid with a coupon: total is below the gross membership fee but the
        // discount explains the gap — not a post-activation edit-down. No exception.
        const oid = `${TAG}-203`;
        const { processId } = await makeApplicant({ email: `revcoupon-${TAG}@ex.com`, status: "ACTIVE", paid: true, shopifyOrderId: oid });
        ordersByLegacyIds.mockResolvedValue([order({ legacyId: oid, financialStatus: "PAID", totalCents: 2000, discountCents: 3000, discountCodes: ["VOLUNTEER50"] })]);
        await runReconcile();
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: processId } }))?.status).toBe("ACTIVE");
        expect(await prisma.paymentException.count({ where: { kind: "AMOUNT_MISMATCH", processId } })).toBe(0);
    });

    it("raises DISCOUNT_UNAUTHORIZED on an already-ACTIVATED non-volunteer order that used the volunteer code", async () => {
        // The webhook activated this in real time (order recorded on the process), so
        // the forward pass never re-examines it — the reversal loop is the daily audit.
        const oid = `${TAG}-204`;
        const { processId } = await makeApplicant({ email: `revvol-${TAG}@ex.com`, status: "ACTIVE", paid: true, shopifyOrderId: oid, isVolunteerFamily: false });
        ordersByLegacyIds.mockResolvedValue([order({ legacyId: oid, financialStatus: "PAID", totalCents: 2000, discountCents: 3000, discountCodes: [VOLUNTEER_CODE] })]);
        await runReconcile();
        // Never auto-reverted — flagged for the board.
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: processId } }))?.status).toBe("ACTIVE");
        expect(await prisma.paymentException.count({ where: { kind: "DISCOUNT_UNAUTHORIZED", processId } })).toBe(1);
    });

    it("raises CANCELLED for a cancelled order", async () => {
        const oid = `${TAG}-202`;
        const { processId } = await makeApplicant({ email: `can-${TAG}@ex.com`, status: "ACTIVE", paid: true, shopifyOrderId: oid });
        ordersByLegacyIds.mockResolvedValue([order({ legacyId: oid, cancelledAt: new Date() })]);
        await runReconcile();
        expect(await prisma.paymentException.findFirst({ where: { kind: "CANCELLED", processId } })).toBeTruthy();
    });
});

describe("program member-code entitlement (judged at the money event)", () => {
    it("does NOT flag a settled past order when the household is later deactivated — status change alone is not evidence", async () => {
        // The scenario the reversal audit used to break: a board member REVOKEs a
        // household through ordinary membership ops, and every past member-priced
        // program order that household holds gets a fraud-shaped flag the next
        // morning. Entitlement is judged when the money moved and never re-derived,
        // so the daily sweep must leave an unreversed, already-ACTIVE order alone.
        const oid = `${TAG}-500`;
        const { personId, programId } = await makeProgramEnrollment({ email: `prgrevoked-${TAG}@ex.com`, status: "ACTIVE", membership: "REVOKED", shopifyOrderId: oid });
        ordersByLegacyIds.mockResolvedValue([order({ legacyId: oid, financialStatus: "PAID", discountCodes: [`PRG${programId}-ABCD1234`] })]);

        await runReconcile();
        expect((await prisma.programParticipant.findUnique({ where: { programId_personId: { programId, personId } } }))?.status).toBe("ACTIVE");
        expect(await prisma.paymentException.count({ where: { kind: "DISCOUNT_UNAUTHORIZED", shopifyOrderId: oid } })).toBe(0);

        // ...and it stays quiet run after run — no reopen loop against the household.
        await runReconcile();
        expect(await prisma.paymentException.count({ where: { kind: "DISCOUNT_UNAUTHORIZED", shopifyOrderId: oid } })).toBe(0);
    });

    it("still raises REFUND on a member-priced enrollment whose money actually came back out", async () => {
        // Guard for the delete above: dropping the entitlement branch must not take
        // the ordinary reversal classification with it.
        const oid = `${TAG}-501`;
        const { programId } = await makeProgramEnrollment({ email: `prgrefund-${TAG}@ex.com`, status: "ACTIVE", membership: "ACTIVE", shopifyOrderId: oid });
        ordersByLegacyIds.mockResolvedValue([
            order({ legacyId: oid, financialStatus: "REFUNDED", totalRefundedCents: 5000, discountCodes: [`PRG${programId}-ABCD1234`] }),
        ]);

        await runReconcile();
        expect(await prisma.paymentException.count({ where: { kind: "REFUND", shopifyOrderId: oid } })).toBe(1);
        expect(await prisma.paymentException.count({ where: { kind: "DISCOUNT_UNAUTHORIZED", shopifyOrderId: oid } })).toBe(0);
    });

    it("activates normally when the paying household IS fee-settled through the program's coverage date", async () => {
        // The entitled money event: same code, same forward path, no flag.
        const oid = `${TAG}-502`;
        const { personId, programId, variantId } = await makeProgramEnrollment({ email: `prgent-${TAG}@ex.com`, status: "PENDING", membership: "ACTIVE" });
        orderLines.mockResolvedValue([{ variantId, quantity: 1, currentQuantity: 1 }]);
        ordersChangedSince.mockResolvedValue([
            order({
                legacyId: oid,
                customerEmail: null,
                discountCodes: [`prg${programId}-abcd1234`],
                noteAttributes: attrs({ Program_ID: String(programId), CheckMeIn_Account_ID: String(personId) }),
            }),
        ]);

        await runReconcile();
        const p = await prisma.programParticipant.findUnique({ where: { programId_personId: { programId, personId } } });
        expect(p?.status).toBe("ACTIVE");
        expect(await prisma.paymentException.count({ where: { kind: "DISCOUNT_UNAUTHORIZED", shopifyOrderId: oid } })).toBe(0);
    });

    it("raises DISCOUNT_UNAUTHORIZED and does NOT activate a PENDING enrollment when the order carries the program's PRG code and the household is unentitled", async () => {
        const email = `prgfwd-${TAG}@ex.com`;
        const oid = `${TAG}-510`;
        const { personId, programId, variantId } = await makeProgramEnrollment({ email, status: "PENDING" });
        orderLines.mockResolvedValue([{ variantId, quantity: 1, currentQuantity: 1 }]);
        // Preferred attribute path (mirrors the enroll checkout link) — no customer
        // email on the order at all, so the attribute alone must carry it.
        ordersChangedSince.mockResolvedValue([
            order({
                legacyId: oid,
                customerEmail: null,
                discountCodes: [`PRG${programId}-ABCD1234`],
                noteAttributes: attrs({ Program_ID: String(programId), CheckMeIn_Account_ID: String(personId) }),
            }),
        ]);

        await runReconcile();
        const p = await prisma.programParticipant.findUnique({ where: { programId_personId: { programId, personId } } });
        expect(p?.status).toBe("PENDING");
        expect(p?.shopifyOrderId).toBeNull();
        expect(await prisma.paymentException.count({ where: { kind: "DISCOUNT_UNAUTHORIZED", shopifyOrderId: oid } })).toBe(1);

        // Idempotent: never activated, so the order is re-examined every run — the
        // exception still must not duplicate.
        await runReconcile();
        expect(await prisma.paymentException.count({ where: { kind: "DISCOUNT_UNAUTHORIZED", shopifyOrderId: oid } })).toBe(1);
    });
});

describe("program order entitlement (same check as the webhook)", () => {
    const statusOf = async (programId: number, personId: number) =>
        (await prisma.programParticipant.findUnique({ where: { programId_personId: { programId, personId } } }))?.status;
    const kinds = async (oid: string) => (await prisma.paymentException.findMany({ where: { shopifyOrderId: oid } })).map((e) => e.kind);

    /** A second household member enrolled PENDING in the same program. */
    async function addSibling(householdId: number, programId: number, email: string): Promise<number> {
        const sib = await prisma.person.create({ data: { email: `sib-${email}`, name: `Sib ${email}`, householdId } });
        await prisma.programParticipant.create({ data: { programId, personId: sib.id, status: "PENDING" } });
        return sib.id;
    }

    it("raises NO_ITEM and does not activate when the attributed order lacks the program variant", async () => {
        const oid = `${TAG}-600`;
        const { personId, programId } = await makeProgramEnrollment({ email: `ent-noitem-${TAG}@ex.com`, status: "PENDING" });
        orderLines.mockResolvedValue([{ variantId: "variant-tshirt-99", quantity: 1, currentQuantity: 1 }]);
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, noteAttributes: attrs({ Program_ID: String(programId), CheckMeIn_Account_ID: String(personId) }) })]);

        await runReconcile();
        expect(await statusOf(programId, personId)).toBe("PENDING");
        expect(await kinds(oid)).toEqual(["NO_ITEM"]);
        await runReconcile();
        expect(await kinds(oid)).toEqual(["NO_ITEM"]);
    });

    it("activates nobody and raises AMOUNT_MISMATCH when the order buys fewer seats than people awaiting payment", async () => {
        const oid = `${TAG}-601`;
        const email = `ent-short-${TAG}@ex.com`;
        const { householdId, personId, programId, variantId } = await makeProgramEnrollment({ email, status: "PENDING" });
        const sibId = await addSibling(householdId, programId, email);
        orderLines.mockResolvedValue([{ variantId, quantity: 1, currentQuantity: 1 }]);
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, noteAttributes: attrs({ Program_ID: String(programId), CheckMeIn_Account_ID: `${personId},${sibId}` }) })]);

        await runReconcile();
        expect(await statusOf(programId, personId)).toBe("PENDING");
        expect(await statusOf(programId, sibId)).toBe("PENDING");
        expect(await kinds(oid)).toEqual(["AMOUNT_MISMATCH"]);
    });

    it("activates nobody and raises MIXED_HOUSEHOLDS when the order names children of two households", async () => {
        const oid = `${TAG}-698`;
        const email = `ent-mixed-${TAG}@ex.com`;
        const { personId, programId, variantId } = await makeProgramEnrollment({ email, status: "PENDING" });
        const otherHh = await prisma.household.create({ data: { name: `HH ${TAG} other-${email}` } });
        const other = await prisma.person.create({ data: { email: `other-${email}`, name: `Other ${email}`, householdId: otherHh.id } });
        await prisma.programParticipant.create({ data: { programId, personId: other.id, status: "PENDING" } });
        orderLines.mockResolvedValue([{ variantId, quantity: 2, currentQuantity: 2 }]);
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, noteAttributes: attrs({ Program_ID: String(programId), CheckMeIn_Account_ID: `${personId},${other.id}` }) })]);

        await runReconcile();
        expect(await statusOf(programId, personId)).toBe("PENDING");
        expect(await statusOf(programId, other.id)).toBe("PENDING");
        expect(await kinds(oid)).toEqual(["MIXED_HOUSEHOLDS"]);
    });

    it("activates everyone when the order buys a seat per person", async () => {
        const oid = `${TAG}-602`;
        const email = `ent-full-${TAG}@ex.com`;
        const { householdId, personId, programId, variantId } = await makeProgramEnrollment({ email, status: "PENDING" });
        const sibId = await addSibling(householdId, programId, email);
        orderLines.mockResolvedValue([{ variantId, quantity: 2, currentQuantity: 2 }]);
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, noteAttributes: attrs({ Program_ID: String(programId), CheckMeIn_Account_ID: `${personId},${sibId}` }) })]);

        await runReconcile();
        expect(await statusOf(programId, personId)).toBe("ACTIVE");
        expect(await statusOf(programId, sibId)).toBe("ACTIVE");
        expect(await kinds(oid)).toEqual([]);
    });

    it("raises AMOUNT_MISMATCH and changes nobody when an activated order is edited down to fewer seats than people on it", async () => {
        const oid = `${TAG}-603`;
        const email = `ent-editdown-${TAG}@ex.com`;
        const { householdId, personId, programId, variantId } = await makeProgramEnrollment({ email, status: "PENDING" });
        const sibId = await addSibling(householdId, programId, email);
        const o = order({ legacyId: oid, noteAttributes: attrs({ Program_ID: String(programId), CheckMeIn_Account_ID: `${personId},${sibId}` }) });
        orderLines.mockResolvedValue([{ variantId, quantity: 2, currentQuantity: 2 }]);
        ordersChangedSince.mockResolvedValue([o]);
        await runReconcile();
        expect(await statusOf(programId, personId)).toBe("ACTIVE");
        expect(await statusOf(programId, sibId)).toBe("ACTIVE");

        // Staff lower the line to 1 seat in Shopify with no refund: still PAID, nothing refunded.
        const edited = { ...o, updatedAt: new Date() };
        const line: IncomeMirrorLineRow = { orderGid: o.orderGid, variantId, title: null, sku: null, quantity: 2, currentQuantity: 1, priceCents: 5000, discountCents: 0 };
        orderLines.mockResolvedValue([{ variantId, quantity: 2, currentQuantity: 1 }]);
        incomeOrderLines.mockResolvedValue([line]);
        ordersChangedSince.mockResolvedValue([edited]);
        ordersByLegacyIds.mockResolvedValue([edited]);

        await runReconcile();
        expect(await statusOf(programId, personId)).toBe("ACTIVE");
        expect(await statusOf(programId, sibId)).toBe("ACTIVE");
        const raised = await prisma.paymentException.findMany({ where: { shopifyOrderId: oid } });
        expect(raised.map((e) => [e.kind, e.programId, e.personId])).toEqual([["AMOUNT_MISMATCH", programId, Math.min(personId, sibId)]]);

        await runReconcile();
        expect(await kinds(oid)).toEqual(["AMOUNT_MISMATCH"]);
    });

    it("raises nothing for an activated order whose current seats still cover everyone on it", async () => {
        const oid = `${TAG}-612`;
        const { personId, programId, variantId } = await makeProgramEnrollment({ email: `ent-covered-${TAG}@ex.com`, status: "ACTIVE", shopifyOrderId: oid });
        const o = order({ legacyId: oid });
        ordersByLegacyIds.mockResolvedValue([o]);
        incomeOrderLines.mockResolvedValue([{ orderGid: o.orderGid, variantId, title: null, sku: null, quantity: 2, currentQuantity: 1, priceCents: 5000, discountCents: 0 }]);

        await runReconcile();
        expect(await statusOf(programId, personId)).toBe("ACTIVE");
        expect(await kinds(oid)).toEqual([]);
    });

    it("does not count a withdrawn person on the order as a seat holder", async () => {
        const oid = `${TAG}-613`;
        const email = `ent-seat-withdrawn-${TAG}@ex.com`;
        const { householdId, personId, programId, variantId } = await makeProgramEnrollment({ email, status: "ACTIVE", shopifyOrderId: oid });
        await prisma.programParticipant.update({ where: { programId_personId: { programId, personId } }, data: { status: "WITHDRAWN", endedAt: new Date() } });
        const sib = await prisma.person.create({ data: { email: `sib-${email}`, name: `Sib ${email}`, householdId } });
        await prisma.programParticipant.create({ data: { programId, personId: sib.id, status: "ACTIVE", shopifyOrderId: oid } });
        const o = order({ legacyId: oid });
        ordersByLegacyIds.mockResolvedValue([o]);
        incomeOrderLines.mockResolvedValue([{ orderGid: o.orderGid, variantId, title: null, sku: null, quantity: 2, currentQuantity: 1, priceCents: 5000, discountCents: 0 }]);

        await runReconcile();
        expect(await statusOf(programId, sib.id)).toBe("ACTIVE");
        expect(await kinds(oid)).toEqual([]);
    });

    it.each([
        ["PARTIALLY_REFUNDED", { financialStatus: "PARTIALLY_REFUNDED", totalRefundedCents: 1000 }],
        ["VOIDED", { financialStatus: "VOIDED" }],
        ["cancelled", { cancelledAt: new Date() }],
    ])("raises REVERSED_BEFORE_ACTIVATION and does not activate a %s order", async (label, over) => {
        const oid = `${TAG}-603-${label}`;
        const { personId, programId, variantId } = await makeProgramEnrollment({ email: `ent-rev-${label}-${TAG}@ex.com`, status: "PENDING" });
        orderLines.mockResolvedValue([{ variantId, quantity: 1, currentQuantity: 1 }]);
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, ...over, noteAttributes: attrs({ Program_ID: String(programId), CheckMeIn_Account_ID: String(personId) }) })]);

        await runReconcile();
        expect(await statusOf(programId, personId)).toBe("PENDING");
        expect(await kinds(oid)).toEqual(["REVERSED_BEFORE_ACTIVATION"]);
    });

    const attributed = (oid: string, programId: number, ids: string) =>
        order({ legacyId: oid, noteAttributes: attrs({ Program_ID: String(programId), CheckMeIn_Account_ID: ids }) });

    it.each([
        ["already paid on another order", `${TAG}-old-order`],
        ["comped or approved (no order)", undefined],
    ])("raises DUPLICATE_PAYMENT, changing nothing, when the child is %s", async (_label, priorOrder) => {
        const oid = `${TAG}-607-${priorOrder ? "paid" : "comp"}`;
        const { personId, programId, variantId } = await makeProgramEnrollment({ email: `ent-dup-${priorOrder ? "paid" : "comp"}-${TAG}@ex.com`, status: "ACTIVE", shopifyOrderId: priorOrder });
        orderLines.mockResolvedValue([{ variantId, quantity: 1, currentQuantity: 1 }]);
        ordersChangedSince.mockResolvedValue([attributed(oid, programId, String(personId))]);

        await runReconcile();
        const row = await prisma.programParticipant.findUnique({ where: { programId_personId: { programId, personId } } });
        expect(row?.shopifyOrderId).toBe(priorOrder ?? null);
        const raised = await prisma.paymentException.findMany({ where: { shopifyOrderId: oid } });
        expect(raised.map((e) => [e.kind, e.personId])).toEqual([["DUPLICATE_PAYMENT", personId]]);
        await runReconcile();
        expect(await kinds(oid)).toEqual(["DUPLICATE_PAYMENT"]);
    });

    it("raises UNCLAIMED_SEATS when the child named has no enrollment (withdrawn or expired)", async () => {
        const oid = `${TAG}-608`;
        const { personId, programId, variantId } = await makeProgramEnrollment({ email: `ent-gone-${TAG}@ex.com`, status: "PENDING" });
        await prisma.programParticipant.delete({ where: { programId_personId: { programId, personId } } });
        orderLines.mockResolvedValue([{ variantId, quantity: 1, currentQuantity: 1 }]);
        ordersChangedSince.mockResolvedValue([attributed(oid, programId, String(personId))]);

        await runReconcile();
        expect(await statusOf(programId, personId)).toBeUndefined();
        expect(await kinds(oid)).toEqual(["UNCLAIMED_SEATS"]);
    });

    it("raises nothing for an order whose child it activated was later withdrawn by the board", async () => {
        const oid = `${TAG}-608w`;
        const { personId, programId, variantId } = await makeProgramEnrollment({ email: `ent-withdrawn-${TAG}@ex.com`, status: "ACTIVE", shopifyOrderId: oid });
        const enrollment = await prisma.programParticipant.delete({ where: { programId_personId: { programId, personId } } });
        const audit = await prisma.auditLog.create({
            data: { actorId: personId, action: "DELETE", tableName: "ProgramParticipant", affectedEntityId: personId, secondaryAffectedEntity: programId, oldData: enrollment },
        });
        orderLines.mockResolvedValue([{ variantId, quantity: 1, currentQuantity: 1 }]);
        ordersChangedSince.mockResolvedValue([attributed(oid, programId, String(personId))]);

        try {
            await runReconcile();
            expect(await kinds(oid)).toEqual([]);
        } finally {
            await prisma.auditLog.delete({ where: { id: audit.id } });
        }
    });

    it("raises nothing for an order whose child withdrew and was since comped back in", async () => {
        const oid = `${TAG}-608r`;
        const { personId, programId, variantId } = await makeProgramEnrollment({ email: `ent-reenrol-${TAG}@ex.com`, status: "ACTIVE", shopifyOrderId: oid });
        const where = { programId_personId: { programId, personId } };
        const withdrawn = await prisma.programParticipant.update({ where, data: { status: "WITHDRAWN", endedAt: new Date() } });
        const audit = await prisma.auditLog.create({
            data: { actorId: personId, action: "EDIT", tableName: "ProgramParticipant", affectedEntityId: personId, secondaryAffectedEntity: programId, newData: withdrawn },
        });
        // Re-enrolment clears the old order from the row.
        await prisma.programParticipant.update({ where, data: { status: "ACTIVE", endedAt: null, shopifyOrderId: null } });
        orderLines.mockResolvedValue([{ variantId, quantity: 1, currentQuantity: 1 }]);
        ordersChangedSince.mockResolvedValue([attributed(oid, programId, String(personId))]);

        try {
            await runReconcile();
            expect(await kinds(oid)).toEqual([]);
        } finally {
            await prisma.auditLog.delete({ where: { id: audit.id } });
        }
    });

    it("activates and raises UNCLAIMED_SEATS when the order buys more seats than people awaiting", async () => {
        const oid = `${TAG}-609`;
        const { personId, programId, variantId } = await makeProgramEnrollment({ email: `ent-extra-${TAG}@ex.com`, status: "PENDING" });
        orderLines.mockResolvedValue([{ variantId, quantity: 3, currentQuantity: 3 }]);
        ordersChangedSince.mockResolvedValue([attributed(oid, programId, String(personId))]);

        await runReconcile();
        expect(await statusOf(programId, personId)).toBe("ACTIVE");
        expect(await kinds(oid)).toEqual(["UNCLAIMED_SEATS"]);
    });

    it("raises nothing for siblings paying on separate orders", async () => {
        const email = `ent-sibs-${TAG}@ex.com`;
        const { householdId, personId, programId, variantId } = await makeProgramEnrollment({ email, status: "PENDING" });
        const sibId = await addSibling(householdId, programId, email);
        orderLines.mockResolvedValue([{ variantId, quantity: 1, currentQuantity: 1 }]);
        ordersChangedSince.mockResolvedValue([attributed(`${TAG}-610a`, programId, String(personId)), attributed(`${TAG}-610b`, programId, String(sibId))]);

        await runReconcile();
        await runReconcile();
        expect(await statusOf(programId, personId)).toBe("ACTIVE");
        expect(await statusOf(programId, sibId)).toBe("ACTIVE");
        expect(await prisma.paymentException.count({ where: { programId } })).toBe(0);
    });

    /** Withdraws an active child, audited as the app does, then re-enrolls them unpaid: the new stint holds no order. */
    async function withdrawAndReenrol(programId: number, personId: number): Promise<number> {
        const where = { programId_personId: { programId, personId } };
        const withdrawn = await prisma.programParticipant.update({ where, data: { status: "WITHDRAWN", endedAt: new Date() } });
        const audit = await prisma.auditLog.create({
            data: { actorId: personId, action: "EDIT", tableName: "ProgramParticipant", affectedEntityId: personId, secondaryAffectedEntity: programId, newData: withdrawn },
        });
        await prisma.programParticipant.update({ where, data: { status: "PENDING", endedAt: null, shopifyOrderId: null } });
        return audit.id;
    }

    /** Removes an active child, audited as the app does, then enrolls them again unpaid. */
    async function removeAndReenrol(programId: number, personId: number): Promise<number> {
        const enrollment = await prisma.programParticipant.delete({ where: { programId_personId: { programId, personId } } });
        const audit = await prisma.auditLog.create({
            data: { actorId: personId, action: "DELETE", tableName: "ProgramParticipant", affectedEntityId: personId, secondaryAffectedEntity: programId, oldData: enrollment },
        });
        await prisma.programParticipant.create({ data: { programId, personId, status: "PENDING" } });
        return audit.id;
    }

    const paidOrder = (oid: string, lines: EntitlementOrder["lines"]): EntitlementOrder =>
        ({ legacyId: oid, financialStatus: "PAID", cancelledAt: null, totalRefundedCents: 0, lines });

    it.each([
        ["withdrew", withdrawAndReenrol],
        ["was removed", removeAndReenrol],
    ])("leaves a child who %s and re-enrolled pending when the order that paid before is re-scanned, raising nothing", async (label, leave) => {
        const oid = `${TAG}-614-${label.replace(/ /g, "-")}`;
        const { personId, programId, variantId } = await makeProgramEnrollment({ email: `ent-spent-${label.replace(/ /g, "-")}-${TAG}@ex.com`, status: "ACTIVE", shopifyOrderId: oid });
        const auditId = await leave(programId, personId);
        orderLines.mockResolvedValue([{ variantId, quantity: 1, currentQuantity: 1 }]);
        ordersChangedSince.mockResolvedValue([attributed(oid, programId, String(personId))]);

        try {
            await runReconcile();
            expect(await statusOf(programId, personId)).toBe("PENDING");
            expect(await kinds(oid)).toEqual([]);
            await runReconcile();
            expect(await statusOf(programId, personId)).toBe("PENDING");
            expect(await kinds(oid)).toEqual([]);
        } finally {
            await prisma.auditLog.delete({ where: { id: auditId } });
        }
    });

    it("counts a sibling still active on the order as a spent seat: a re-enrolled sibling stays pending", async () => {
        const oid = `${TAG}-615`;
        const email = `ent-spent-sib-${TAG}@ex.com`;
        const { householdId, programId, variantId } = await makeProgramEnrollment({ email, status: "ACTIVE", shopifyOrderId: oid });
        const sib = await prisma.person.create({ data: { email: `sib-${email}`, name: `Sib ${email}`, householdId } });
        await prisma.programParticipant.create({ data: { programId, personId: sib.id, status: "ACTIVE", shopifyOrderId: oid } });
        const auditId = await withdrawAndReenrol(programId, sib.id);

        try {
            const judged = await orderEntitlesEnrollment(paidOrder(oid, [{ variantId, quantity: 2, currentQuantity: 2 }]), programId, [sib.id]);
            expect(judged).toEqual({ ok: false, kind: null, spent: true });
            expect(await statusOf(programId, sib.id)).toBe("PENDING");
        } finally {
            await prisma.auditLog.delete({ where: { id: auditId } });
        }
    });

    it("honours a seat an edit added to an order that already activated someone", async () => {
        const oid = `${TAG}-616`;
        const email = `ent-spent-added-${TAG}@ex.com`;
        const { householdId, programId, variantId } = await makeProgramEnrollment({ email, status: "ACTIVE", shopifyOrderId: oid });
        const sibId = await addSibling(householdId, programId, email);
        // The edit arrives as a new line beside the original one.
        const lines = [{ variantId, quantity: 1, currentQuantity: 1 }, { variantId, quantity: 1, currentQuantity: 1 }];

        const judged = await orderEntitlesEnrollment(paidOrder(oid, lines), programId, [sibId]);
        expect(judged).toEqual({ ok: true, surplus: undefined });
        await activateProgramEnrollment({ programId, personIds: [sibId], shopifyOrderId: oid, lines });
        expect(await statusOf(programId, sibId)).toBe("ACTIVE");
    });

    it("pays for nobody new once an edit lowers the order's seats to those already spent", async () => {
        const oid = `${TAG}-617`;
        const email = `ent-spent-lowered-${TAG}@ex.com`;
        const { householdId, programId, variantId } = await makeProgramEnrollment({ email, status: "ACTIVE", shopifyOrderId: oid });
        const sib = await prisma.person.create({ data: { email: `sib-${email}`, name: `Sib ${email}`, householdId } });
        await prisma.programParticipant.create({ data: { programId, personId: sib.id, status: "ACTIVE", shopifyOrderId: oid } });
        const auditId = await withdrawAndReenrol(programId, sib.id);

        try {
            const judged = await orderEntitlesEnrollment(paidOrder(oid, [{ variantId, quantity: 2, currentQuantity: 1 }]), programId, [sib.id]);
            expect(judged).toEqual({ ok: false, kind: null, spent: true });
            expect(await statusOf(programId, sib.id)).toBe("PENDING");
        } finally {
            await prisma.auditLog.delete({ where: { id: auditId } });
        }
    });

    it("judges seats by the current quantity: a seat an edit removed pays for nobody", async () => {
        const oid = `${TAG}-618`;
        const email = `ent-spent-current-${TAG}@ex.com`;
        const { householdId, programId, variantId } = await makeProgramEnrollment({ email, status: "ACTIVE", shopifyOrderId: oid });
        const sibId = await addSibling(householdId, programId, email);

        const judged = await orderEntitlesEnrollment(paidOrder(oid, [{ variantId, quantity: 2, currentQuantity: 1 }]), programId, [sibId]);
        expect(judged).toEqual({ ok: false, kind: null, spent: true });
        expect(await statusOf(programId, sibId)).toBe("PENDING");
    });

    it("counts a child a restocking refund removed as spent once: the replayed payment-time order still pays for the free seat, and the refunded order pays for nobody", async () => {
        const oid = `${TAG}-619`;
        const email = `ent-spent-refunded-${TAG}@ex.com`;
        const { householdId, personId, programId, variantId } = await makeProgramEnrollment({ email, status: "ACTIVE", shopifyOrderId: oid });
        const refunded = await prisma.person.create({ data: { email: `refunded-${email}`, name: `Refunded ${email}`, householdId } });
        const enrollment = await prisma.programParticipant.create({ data: { programId, personId: refunded.id, status: "ACTIVE", shopifyOrderId: oid } });
        await prisma.programParticipant.delete({ where: { programId_personId: { programId, personId: refunded.id } } });
        const audit = await prisma.auditLog.create({
            data: { ...systemActor("webhook:shopify-refund"), action: "DELETE", tableName: "ProgramParticipant", affectedEntityId: refunded.id, secondaryAffectedEntity: programId, oldData: enrollment },
        });
        const sibId = await addSibling(householdId, programId, email);

        try {
            // A redelivered orders/paid carries the order as it was paid: three seats, nothing refunded.
            const replay = await orderEntitlesEnrollment(paidOrder(oid, [{ variantId, quantity: 3, currentQuantity: 3 }]), programId, [sibId]);
            expect(replay).toEqual({ ok: true, surplus: undefined });
            // The mirror sees the refund, and a refunded order activates nobody.
            const mirrored = { ...paidOrder(oid, [{ variantId, quantity: 3, currentQuantity: 2 }]), financialStatus: "PARTIALLY_REFUNDED", totalRefundedCents: 5000 };
            expect(await orderEntitlesEnrollment(mirrored, programId, [sibId])).toEqual({ ok: false, kind: "REVERSED_BEFORE_ACTIVATION" });
            expect(await statusOf(programId, personId)).toBe("ACTIVE");
        } finally {
            await prisma.auditLog.delete({ where: { id: audit.id } });
        }
    });

    it("waits on an order not yet paid: no activation, no exception", async () => {
        const oid = `${TAG}-604`;
        const { personId, programId, variantId } = await makeProgramEnrollment({ email: `ent-unpaid-${TAG}@ex.com`, status: "PENDING" });
        orderLines.mockResolvedValue([{ variantId, quantity: 1, currentQuantity: 1 }]);
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, financialStatus: "PARTIALLY_PAID", noteAttributes: attrs({ Program_ID: String(programId), CheckMeIn_Account_ID: String(personId) }) })]);

        await runReconcile();
        expect(await statusOf(programId, personId)).toBe("PENDING");
        expect(await kinds(oid)).toEqual([]);
    });

    it("email fallback leaves a lead's merchandise order untouched", async () => {
        const oid = `${TAG}-605`;
        const email = `ent-merch-${TAG}@ex.com`;
        const { personId, programId } = await makeProgramEnrollment({ email, status: "PENDING" });
        orderLines.mockResolvedValue([{ variantId: "variant-tshirt-99", quantity: 1, currentQuantity: 1 }]);
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, customerEmail: email })]);

        await runReconcile();
        expect(await statusOf(programId, personId)).toBe("PENDING");
        expect(await kinds(oid)).toEqual([]);
    });

    it("a mixed membership + program order recovers BOTH the membership and the program seat", async () => {
        const oid = `${TAG}-607`;
        const { processId } = await makeApplicant({ email: `mixed-mem-${TAG}@ex.com`, status: "PENDING_PAYMENT", bgCleared: true });
        const { personId, programId, variantId } = await makeProgramEnrollment({ email: `mixed-prg-${TAG}@ex.com`, status: "PENDING" });
        orderLineVariantIds.mockResolvedValue([MEMBERSHIP_VARIANT, variantId]);
        orderLines.mockResolvedValue([{ variantId: MEMBERSHIP_VARIANT, quantity: 1, currentQuantity: 1 }, { variantId, quantity: 1, currentQuantity: 1 }]);
        ordersChangedSince.mockResolvedValue([
            order({ legacyId: oid, noteAttributes: attrs({ Membership_Process_ID: String(processId), Program_ID: String(programId), CheckMeIn_Account_ID: String(personId) }) }),
        ]);

        await runReconcile();
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: processId } }))?.status).toBe("ACTIVE");
        expect(await statusOf(programId, personId)).toBe("ACTIVE");
        expect(await kinds(oid)).toEqual([]);

        await runReconcile();
        expect(await kinds(oid)).toEqual([]);
    });

    it("email fallback activates when the order carries the pending program's variant", async () => {
        const oid = `${TAG}-606`;
        const email = `ent-fallback-${TAG}@ex.com`;
        const { personId, programId, variantId } = await makeProgramEnrollment({ email, status: "PENDING" });
        orderLines.mockResolvedValue([{ variantId, quantity: 1, currentQuantity: 1 }]);
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, customerEmail: email })]);

        await runReconcile();
        expect(await statusOf(programId, personId)).toBe("ACTIVE");
        expect(await kinds(oid)).toEqual([]);
    });
});

describe("fast-path reversal webhook helper", () => {
    it("raiseReversalByOrderId maps an order to its process and is idempotent", async () => {
        const oid = `${TAG}-300`;
        const { processId } = await makeApplicant({ email: `fp-${TAG}@ex.com`, status: "ACTIVE", paid: true, shopifyOrderId: oid });
        expect(await raiseReversalByOrderId(oid, "REFUND")).toBe(true);
        await raiseReversalByOrderId(oid, "REFUND");
        expect(await prisma.paymentException.count({ where: { kind: "REFUND", processId } })).toBe(1);
    });

    /** A second child in the first enrollee's household, on the same program and order. */
    async function addSibling(e: { householdId: number; programId: number }, shopifyOrderId: string): Promise<number> {
        const kid = await prisma.person.create({ data: { name: `Kid ${TAG} ${shopifyOrderId}`, householdId: e.householdId } });
        await prisma.programParticipant.create({ data: { programId: e.programId, personId: kid.id, status: "ACTIVE", shopifyOrderId } });
        return kid.id;
    }
    const enrolled = (programId: number) => prisma.programParticipant.count({ where: { programId } });
    const statusOf = async (programId: number, personId: number) =>
        (await prisma.programParticipant.findUnique({ where: { programId_personId: { programId, personId } } }))?.status;

    const takenBack = () => adjustInventory.mock.calls.map(([, delta]) => delta);
    /** A refunds/create delivery; the same refundId again is a Shopify redelivery. */
    const refund = (oid: string, lines: Parameters<typeof raiseReversalByOrderId>[2], refundId = `${oid}-r1`) =>
        raiseReversalByOrderId(oid, "REFUND", lines, refundId);
    /** An enrollment in a program still on sale (the fixture's start date has passed). */
    async function makeOnSaleEnrollment(opts: Parameters<typeof makeProgramEnrollment>[0]) {
        const e = await makeProgramEnrollment(opts);
        await prisma.program.update({ where: { id: e.programId }, data: { offSaleAt: new Date("2099-01-01") } });
        return e;
    }

    it("a restocked refund after the sale has ended removes the child and takes every restocked seat back off sale", async () => {
        const oid = `${TAG}-325`;
        const e = await makeOnSaleEnrollment({ email: `rs15-${TAG}@ex.com`, status: "ACTIVE", shopifyOrderId: oid });
        await prisma.program.update({ where: { id: e.programId }, data: { saleEndedAt: new Date() } });
        orderLines.mockResolvedValue([{ variantId: e.variantId, quantity: 1, currentQuantity: 1 }]);
        await refund(oid, [{ variantId: e.variantId, quantity: 1, lineQuantity: 1 }]);
        await refund(oid, [{ variantId: e.variantId, quantity: 1, lineQuantity: 1 }]);
        expect(await enrolled(e.programId)).toBe(0);
        expect(takenBack()).toEqual([-1]);
    });

    it("a restocked refund after the sale has ended on an order no row records takes the seat back off sale, once", async () => {
        const e = await makeOnSaleEnrollment({ email: `rs16-${TAG}@ex.com`, status: "ACTIVE", shopifyOrderId: `${TAG}-326-paid` });
        await prisma.program.update({ where: { id: e.programId }, data: { saleEndedAt: new Date() } });
        const oid = `${TAG}-326`;
        expect(await refund(oid, [{ variantId: e.variantId, quantity: 1, lineQuantity: 1 }])).toBe(false);
        await refund(oid, [{ variantId: e.variantId, quantity: 1, lineQuantity: 1 }]);
        expect(await enrolled(e.programId)).toBe(1);
        expect(takenBack()).toEqual([-1]);
    });

    it("a restocked refund before the sale has ended on an order no row records leaves the seat on sale", async () => {
        const e = await makeOnSaleEnrollment({ email: `rs17-${TAG}@ex.com`, status: "ACTIVE", shopifyOrderId: `${TAG}-327-paid` });
        await refund(`${TAG}-327`, [{ variantId: e.variantId, quantity: 1, lineQuantity: 1 }]);
        expect(await enrolled(e.programId)).toBe(1);
        expect(takenBack()).toEqual([]);
    });

    it("a test order gives back the public seats Shopify took, once per order", async () => {
        const e = await makeOnSaleEnrollment({ email: `rs18-${TAG}@ex.com`, status: "ACTIVE" });
        const oid = `${TAG}-328`;
        await returnTestOrderStock(oid, [{ variantId: e.variantId, quantity: 2 }, { variantId: "variant-unrelated", quantity: 1 }]);
        await returnTestOrderStock(oid, [{ variantId: e.variantId, quantity: 2 }]);
        expect(takenBack()).toEqual([2]);
    });

    it("a test order refunded with restock before the sale has ended takes its given-back seats back off sale, once", async () => {
        const e = await makeOnSaleEnrollment({ email: `rs19-${TAG}@ex.com`, status: "ACTIVE" });
        const oid = `${TAG}-329`;
        await returnTestOrderStock(oid, [{ variantId: e.variantId, quantity: 2 }]);
        await refund(oid, [{ variantId: e.variantId, quantity: 2, lineQuantity: 2 }]);
        await refund(oid, [{ variantId: e.variantId, quantity: 2, lineQuantity: 2 }]);
        expect(takenBack()).toEqual([2, -2]);
    });

    it("a redelivered refund that removed a named sibling takes nothing back", async () => {
        const oid = `${TAG}-323`;
        const e = await makeOnSaleEnrollment({ email: `rs13-${TAG}@ex.com`, status: "ACTIVE", shopifyOrderId: oid });
        const kidId = await addSibling(e, oid);
        orderLines.mockResolvedValue([{ variantId: e.variantId, quantity: 1, currentQuantity: 1 }, { variantId: e.variantId, quantity: 1, currentQuantity: 1 }]);
        const lines = [{ variantId: e.variantId, quantity: 1, lineQuantity: 1, personIds: [kidId] }];
        await refund(oid, lines);
        await refund(oid, lines);
        const left = await prisma.programParticipant.findMany({ where: { programId: e.programId }, select: { personId: true } });
        expect(left.map((r) => r.personId)).toEqual([e.personId]);
        expect(takenBack()).toEqual([]);
    });

    it("a redelivered partial refund takes its seat back once; a second refund takes its own", async () => {
        const oid = `${TAG}-324`;
        const e = await makeOnSaleEnrollment({ email: `rs14-${TAG}@ex.com`, status: "ACTIVE", shopifyOrderId: oid });
        await addSibling(e, oid);
        orderLines.mockResolvedValue([{ variantId: e.variantId, quantity: 2, currentQuantity: 2 }]);
        const lines = [{ variantId: e.variantId, quantity: 1, lineQuantity: 2 }];
        await Promise.all([refund(oid, lines), refund(oid, lines)]);
        await refund(oid, lines);
        expect(takenBack()).toEqual([-1]);
        await refund(oid, lines, `${oid}-r2`);
        expect(takenBack()).toEqual([-1, -1]);
        expect(await enrolled(e.programId)).toBe(2);
    });


    it("a restocked refund removes the enrollment, flags it, and is idempotent", async () => {
        const oid = `${TAG}-310`;
        const e = await makeOnSaleEnrollment({ email: `rs1-${TAG}@ex.com`, status: "ACTIVE", shopifyOrderId: oid });
        orderLines.mockResolvedValue([{ variantId: e.variantId, quantity: 1, currentQuantity: 1 }]);
        const lines = [{ variantId: e.variantId, quantity: 1, lineQuantity: 1 }];
        expect(await refund(oid, lines)).toBe(true);
        await refund(oid, lines);
        expect(await enrolled(e.programId)).toBe(0);
        expect(await prisma.paymentException.count({ where: { kind: "REFUND", programId: e.programId, personId: e.personId } })).toBe(1);
        expect(await prisma.auditLog.count({ where: { actorSystem: "webhook:shopify-refund", tableName: "ProgramParticipant", secondaryAffectedEntity: e.programId } })).toBe(1);
        expect(takenBack()).toEqual([]);
    });

    it("a restocked refund on a withdrawn paid place records the refund on the row and keeps it; the restock stands", async () => {
        const oid = `${TAG}-330`;
        const e = await makeOnSaleEnrollment({ email: `rs20-${TAG}@ex.com`, status: "ACTIVE", shopifyOrderId: oid });
        await prisma.programParticipant.update({
            where: { programId_personId: { programId: e.programId, personId: e.personId } },
            data: { status: "WITHDRAWN", endedAt: new Date() },
        });
        orderLines.mockResolvedValue([{ variantId: e.variantId, quantity: 1, currentQuantity: 1 }]);
        expect(await refund(oid, [{ variantId: e.variantId, quantity: 1, lineQuantity: 1 }])).toBe(true);
        const row = await prisma.programParticipant.findUnique({ where: { programId_personId: { programId: e.programId, personId: e.personId } } });
        expect(row?.status).toBe("WITHDRAWN");
        expect(await prisma.paymentException.count({ where: { kind: "REFUND", programId: e.programId, personId: e.personId } })).toBe(1);
        expect(await prisma.auditLog.count({ where: { actorSystem: "webhook:shopify-refund", tableName: "ProgramParticipant", action: "EDIT", secondaryAffectedEntity: e.programId } })).toBe(1);
        expect(takenBack()).toEqual([]);
    });

    it("a restocked refund on a withdrawn place whose withdrawal already returned the seat takes the extra unit back", async () => {
        const oid = `${TAG}-331`;
        const e = await makeOnSaleEnrollment({ email: `rs21-${TAG}@ex.com`, status: "ACTIVE", shopifyOrderId: oid });
        await prisma.programParticipant.update({
            where: { programId_personId: { programId: e.programId, personId: e.personId } },
            data: { status: "WITHDRAWN", endedAt: new Date(), seatTakenWithoutSaleAt: new Date() },
        });
        orderLines.mockResolvedValue([{ variantId: e.variantId, quantity: 1, currentQuantity: 1 }]);
        await refund(oid, [{ variantId: e.variantId, quantity: 1, lineQuantity: 1 }]);
        expect(await enrolled(e.programId)).toBe(1);
        expect(takenBack()).toEqual([-1]);
    });

    it("a refund without restock only flags; the enrollment stays", async () => {
        const oid = `${TAG}-311`;
        const e = await makeOnSaleEnrollment({ email: `rs2-${TAG}@ex.com`, status: "ACTIVE", shopifyOrderId: oid });
        await refund(oid, []);
        expect(await enrolled(e.programId)).toBe(1);
        expect(await prisma.paymentException.count({ where: { kind: "REFUND", programId: e.programId } })).toBe(1);
    });

    it("a restock of another variant leaves the enrollment", async () => {
        const oid = `${TAG}-312`;
        const e = await makeOnSaleEnrollment({ email: `rs3-${TAG}@ex.com`, status: "ACTIVE", shopifyOrderId: oid });
        await refund(oid, [{ variantId: "some-other-variant", quantity: 1, lineQuantity: 1 }]);
        expect(await enrolled(e.programId)).toBe(1);
        expect(takenBack()).toEqual([]);
    });

    it("one line of 2 seats fully restocked: both children removed, both flagged", async () => {
        const oid = `${TAG}-313`;
        const e = await makeOnSaleEnrollment({ email: `rs4-${TAG}@ex.com`, status: "ACTIVE", shopifyOrderId: oid });
        const kidId = await addSibling(e, oid);
        orderLines.mockResolvedValue([{ variantId: e.variantId, quantity: 2, currentQuantity: 2 }]);
        await refund(oid, [{ variantId: e.variantId, quantity: 2, lineQuantity: 2 }]);
        const flagged = await prisma.paymentException.findMany({ where: { kind: "REFUND", shopifyOrderId: oid }, select: { personId: true } });
        expect(flagged.map((f) => f.personId).sort()).toEqual([e.personId, kidId].sort());
        expect(await enrolled(e.programId)).toBe(0);
        expect(takenBack()).toEqual([]);
    });

    it("sibling lines, one restocked: only the child that line names is removed", async () => {
        const oid = `${TAG}-318`;
        const e = await makeOnSaleEnrollment({ email: `rs9-${TAG}@ex.com`, status: "ACTIVE", shopifyOrderId: oid });
        const kidId = await addSibling(e, oid);
        orderLines.mockResolvedValue([{ variantId: e.variantId, quantity: 1, currentQuantity: 1 }, { variantId: e.variantId, quantity: 1, currentQuantity: 1 }]);
        await refund(oid, [{ variantId: e.variantId, quantity: 1, lineQuantity: 1, personIds: [kidId] }]);
        const left = await prisma.programParticipant.findMany({ where: { programId: e.programId }, select: { personId: true } });
        expect(left.map((r) => r.personId)).toEqual([e.personId]);
        expect(takenBack()).toEqual([]);
    });

    it("a partial restock with no child named removes nobody and takes the seat back off sale", async () => {
        const oid = `${TAG}-314`;
        const e = await makeOnSaleEnrollment({ email: `rs5-${TAG}@ex.com`, status: "ACTIVE", shopifyOrderId: oid });
        await addSibling(e, oid);
        orderLines.mockResolvedValue([{ variantId: e.variantId, quantity: 2, currentQuantity: 2 }]);
        await refund(oid, [{ variantId: e.variantId, quantity: 1, lineQuantity: 2 }]);
        expect(await enrolled(e.programId)).toBe(2);
        expect(await prisma.paymentException.count({ where: { kind: "REFUND", shopifyOrderId: oid } })).toBe(2);
        expect(takenBack()).toEqual([-1]);
    });

    it("an order the mirror hasn't synced yet: nobody removed, the restocked seat taken back", async () => {
        const oid = `${TAG}-319`;
        const e = await makeOnSaleEnrollment({ email: `rs10-${TAG}@ex.com`, status: "ACTIVE", shopifyOrderId: oid });
        await refund(oid, [{ variantId: e.variantId, quantity: 1, lineQuantity: 1 }]);
        expect(await enrolled(e.programId)).toBe(1);
        expect(takenBack()).toEqual([-1]);
    });

    it("a restocked claimant-variant refund is flag-only: nobody removed, no stock change", async () => {
        const oid = `${TAG}-321`;
        const e = await makeOnSaleEnrollment({ email: `rs11-${TAG}@ex.com`, status: "ACTIVE", shopifyOrderId: oid });
        const claimant = `claimant-${e.variantId}`;
        await prisma.program.update({ where: { id: e.programId }, data: { claimantShopifyVariantId: claimant } });
        orderLines.mockResolvedValue([{ variantId: claimant, quantity: 1, currentQuantity: 1 }]);
        await refund(oid, [{ variantId: claimant, quantity: 1, lineQuantity: 1, personIds: [e.personId] }]);
        expect(await enrolled(e.programId)).toBe(1);
        expect(await prisma.paymentException.count({ where: { kind: "REFUND", shopifyOrderId: oid } })).toBe(1);
        expect(takenBack()).toEqual([]);
    });

    it("a public seat and a claimant seat, only the public line restocked: nobody removed, the seat taken back", async () => {
        const oid = `${TAG}-322`;
        const e = await makeOnSaleEnrollment({ email: `rs12-${TAG}@ex.com`, status: "ACTIVE", shopifyOrderId: oid });
        await addSibling(e, oid);
        const claimant = `claimant-${e.variantId}`;
        await prisma.program.update({ where: { id: e.programId }, data: { claimantShopifyVariantId: claimant } });
        orderLines.mockResolvedValue([{ variantId: e.variantId, quantity: 1, currentQuantity: 1 }, { variantId: claimant, quantity: 1, currentQuantity: 1 }]);
        await refund(oid, [{ variantId: e.variantId, quantity: 1, lineQuantity: 1 }]);
        expect(await enrolled(e.programId)).toBe(2);
        expect(takenBack()).toEqual([-1]);
    });

    it("one child on an order that bought 2 seats: restocking 1 keeps the child who paid", async () => {
        const oid = `${TAG}-316`;
        const e = await makeOnSaleEnrollment({ email: `rs7-${TAG}@ex.com`, status: "ACTIVE", shopifyOrderId: oid });
        orderLines.mockResolvedValue([{ variantId: e.variantId, quantity: 2, currentQuantity: 2 }]);
        await refund(oid, [{ variantId: e.variantId, quantity: 1, lineQuantity: 2 }]);
        expect(await enrolled(e.programId)).toBe(1);
        expect(await prisma.paymentException.count({ where: { kind: "REFUND", shopifyOrderId: oid } })).toBe(1);
    });

    it("siblings on one order, one withdrew: an unnamed partial restock keeps both and takes the seat back", async () => {
        const oid = `${TAG}-317`;
        const e = await makeOnSaleEnrollment({ email: `rs8-${TAG}@ex.com`, status: "ACTIVE", shopifyOrderId: oid });
        const kidId = await addSibling(e, oid);
        await prisma.programParticipant.update({
            where: { programId_personId: { programId: e.programId, personId: kidId } },
            data: { status: "WITHDRAWN", endedAt: new Date() },
        });
        orderLines.mockResolvedValue([{ variantId: e.variantId, quantity: 2, currentQuantity: 2 }]);
        await refund(oid, [{ variantId: e.variantId, quantity: 1, lineQuantity: 2 }]);
        expect(await statusOf(e.programId, e.personId)).toBe("ACTIVE");
        expect(await statusOf(e.programId, kidId)).toBe("WITHDRAWN");
        expect(takenBack()).toEqual([-1]);
    });

    it("a restocked cancellation is not a refund: flags only", async () => {
        const oid = `${TAG}-315`;
        const e = await makeOnSaleEnrollment({ email: `rs6-${TAG}@ex.com`, status: "ACTIVE", shopifyOrderId: oid });
        await raiseReversalByOrderId(oid, "CANCELLED", [{ variantId: e.variantId, quantity: 1, lineQuantity: 1 }]);
        expect(await enrolled(e.programId)).toBe(1);
    });
});

describe("daily reversal pass, multi-person order", () => {
    it("raises REFUND for every person on the order", async () => {
        const oid = `${TAG}-320`;
        const e = await makeProgramEnrollment({ email: `dp1-${TAG}@ex.com`, status: "ACTIVE", shopifyOrderId: oid });
        const kid = await prisma.person.create({ data: { name: `Kid ${TAG} ${oid}`, householdId: e.householdId } });
        await prisma.programParticipant.create({ data: { programId: e.programId, personId: kid.id, status: "ACTIVE", shopifyOrderId: oid } });
        ordersByLegacyIds.mockResolvedValue([order({ legacyId: oid, financialStatus: "REFUNDED", totalRefundedCents: 5000 })]);
        await runReconcile();
        await runReconcile();
        expect(await prisma.paymentException.count({ where: { kind: "REFUND", shopifyOrderId: oid } })).toBe(2);
        expect(await prisma.programParticipant.count({ where: { programId: e.programId } })).toBe(2);
    });
});
