/**
 * @jest-environment node
 */
/**
 * Matrix test for the Shopify reconciler (lib/finance/reconcile.ts). Real app DB,
 * mocked `shopify_read` mirror (fixtures) — so every taxonomy row is exercised
 * against real membership/program state without needing a second Postgres. Each
 * assertion also re-runs to prove idempotency (no double activation, no duplicate
 * PaymentException).
 */
import prisma from "@/lib/prisma";
import { runReconcile, raiseReversalByOrderId } from "@/lib/finance/reconcile";
import type { MirrorOrder } from "@/lib/shopifyRead/client";

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
    // Default [] = a pre-#1048 order with no mirrored line variant ids, which drives
    // the reconciler's transitional amount-gate fallback. Tests of the variant path
    // set this explicitly.
    orderLineVariantIds: jest.fn(async () => [] as string[]),
    orderLines: jest.fn(async () => [] as { variantId: string; quantity: number }[]),
}));
import * as mirror from "@/lib/shopifyRead/client";

const TAG = "reconcile-matrix-test";
// A membership variant id the board has configured; #1048 mirrors it onto order lines.
const MEMBERSHIP_VARIANT = "variant-normal-1";
const ordersChangedSince = mirror.ordersChangedSince as jest.Mock;
const ordersByLegacyIds = mirror.ordersByLegacyIds as jest.Mock;
const disputedOrderGids = mirror.disputedOrderGids as jest.Mock;
const orderLineVariantIds = mirror.orderLineVariantIds as jest.Mock;
const orderLines = mirror.orderLines as jest.Mock;

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
    status: "PENDING_PAYMENT" | "ACTIVE";
    bgCleared?: boolean;
    isVolunteer?: boolean;
    shopifyOrderId?: string;
    paid?: boolean;
}): Promise<{ householdId: number; processId: number; membershipId: number }> {
    const hh = await prisma.household.create({ data: { name: `HH ${TAG} ${opts.email}` } });
    await prisma.person.create({
        data: { email: opts.email, name: `Lead ${opts.email}`, isHouseholdLead: true, householdId: hh.id },
    });
    const m = await prisma.orgMembership.create({
        data: { householdId: hh.id, status: opts.status === "ACTIVE" ? "ACTIVE" : "NONE", isVolunteer: !!opts.isVolunteer },
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

// The board-configured volunteer-rate coupon (BoardSettings.volunteerDiscountCode).
// Distinct from the "VOLUNTEER50" promo-style code other cases use, which must stay
// unregistered-as-volunteer so they exercise the codes-are-Shopify's-business path.
const VOLUNTEER_CODE = "VOLFAM";

/**
 * A household with one lead Person enrolled in one Program, mirroring the shape
 * `unentitledMemberCodeUse` needs: a Program with dates (so `programCoverageDate`
 * yields a real through-date), a Household, and a ProgramParticipant at the given
 * status. `membership` seeds an OrgMembership at that status — REVOKED is the
 * deactivated household (no `orgMembershipYearBoundary` is configured in this
 * suite's BoardSettings, so an ACTIVE one covers any date).
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
        data: { name: `Program ${TAG} ${opts.email}`, startAt: new Date("2026-06-01"), endAt: new Date("2026-08-01"), shopifyVariantId: variantId },
    });
    await prisma.programParticipant.create({
        data: { programId: program.id, personId: person.id, status: opts.status, shopifyOrderId: opts.shopifyOrderId ?? null },
    });
    return { householdId: hh.id, personId: person.id, programId: program.id, variantId };
}

beforeAll(async () => {
    await prisma.boardSettings.upsert({
        where: { id: 1 },
        create: { id: 1, standardMembershipFeeCents: 5000, volunteerMembershipFeeCents: 2000, orgMembershipVariantId: MEMBERSHIP_VARIANT, volunteerDiscountCode: VOLUNTEER_CODE },
        update: { standardMembershipFeeCents: 5000, volunteerMembershipFeeCents: 2000, orgMembershipVariantId: MEMBERSHIP_VARIANT, volunteerDiscountCode: VOLUNTEER_CODE, shopifyReconcileCursorAt: null },
    });
});

afterEach(async () => {
    ordersChangedSince.mockResolvedValue([]);
    ordersByLegacyIds.mockResolvedValue([]);
    disputedOrderGids.mockResolvedValue(new Set());
    orderLineVariantIds.mockResolvedValue([]);
    orderLines.mockResolvedValue([]);
    // Reset cursor so each test scans its own fixtures from scratch.
    await prisma.boardSettings.update({ where: { id: 1 }, data: { shopifyReconcileCursorAt: null } });
});

afterAll(async () => {
    const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const ids = hhs.map((h) => h.id);
    if (ids.length) {
        const procs = await prisma.orgMembershipProcess.findMany({ where: { orgMembership: { householdId: { in: ids } } }, select: { id: true } });
        await prisma.paymentException.deleteMany({ where: { processId: { in: procs.map((p) => p.id) } } });
        await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: ids } } } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
    }

    const programs = await prisma.program.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const programIds = programs.map((p) => p.id);
    if (programIds.length) {
        await prisma.paymentException.deleteMany({ where: { programId: { in: programIds } } });
        await prisma.programParticipant.deleteMany({ where: { programId: { in: programIds } } });
        await prisma.program.deleteMany({ where: { id: { in: programIds } } });
    }

    if (ids.length) {
        await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.paymentException.deleteMany({ where: { shopifyOrderId: { startsWith: `${TAG}-` } } });
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

    it("raises AMOUNT_MISMATCH and does not activate when the order underpays dues", async () => {
        const email = `short-${TAG}@ex.com`;
        const oid = `${TAG}-102`;
        const { processId } = await makeApplicant({ email, status: "PENDING_PAYMENT", bgCleared: true });
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, customerEmail: email, totalCents: 1000 })]);
        await runReconcile();
        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(proc?.status).toBe("PENDING_PAYMENT");
        expect(await prisma.paymentException.findFirst({ where: { kind: "AMOUNT_MISMATCH", shopifyOrderId: oid } })).toBeTruthy();
    });

    it("recovers a couponed order below gross dues (variant match), no AMOUNT_MISMATCH", async () => {
        // #1048: the volunteer rate / promos are Shopify coupons, so a valid order's
        // total is below gross dues. It carries a known membership variant line → recover.
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
        const { processId } = await makeApplicant({ email, status: "PENDING_PAYMENT", bgCleared: true, isVolunteer: false });
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
        const { processId } = await makeApplicant({ email, status: "PENDING_PAYMENT", bgCleared: true, isVolunteer: true });
        orderLineVariantIds.mockResolvedValue([MEMBERSHIP_VARIANT]);
        ordersChangedSince.mockResolvedValue([
            order({ legacyId: oid, customerEmail: email, totalCents: 2000, discountCents: 3000, discountCodes: [VOLUNTEER_CODE] }),
        ]);
        await runReconcile();
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: processId } }))?.status).toBe("ACTIVE");
        expect(await prisma.paymentException.count({ where: { processId } })).toBe(0);
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

    it("pre-backfill order (no variant ids) genuinely short of dues still raises AMOUNT_MISMATCH", async () => {
        // orderLineVariantIds default [] = pre-#1048, no discount codes → amount fallback.
        const email = `prebackfill-${TAG}@ex.com`;
        const oid = `${TAG}-122`;
        const { processId } = await makeApplicant({ email, status: "PENDING_PAYMENT", bgCleared: true });
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, customerEmail: email, totalCents: 1000, discountCents: 0, discountCodes: [] })]);
        await runReconcile();
        expect((await prisma.orgMembershipProcess.findUnique({ where: { id: processId } }))?.status).toBe("PENDING_PAYMENT");
        expect(await prisma.paymentException.findFirst({ where: { kind: "AMOUNT_MISMATCH", shopifyOrderId: oid } })).toBeTruthy();
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

    it("does not raise AMOUNT_MISMATCH on a couponed order below gross dues (post-activation)", async () => {
        // ACTIVE membership paid with a coupon: total is below gross dues but the
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
        const { processId } = await makeApplicant({ email: `revvol-${TAG}@ex.com`, status: "ACTIVE", paid: true, shopifyOrderId: oid, isVolunteer: false });
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

    it("activates normally when the paying household IS dues-settled through the program's coverage date", async () => {
        // The entitled money event: same code, same forward path, no flag.
        const oid = `${TAG}-502`;
        const { personId, programId, variantId } = await makeProgramEnrollment({ email: `prgent-${TAG}@ex.com`, status: "PENDING", membership: "ACTIVE" });
        orderLines.mockResolvedValue([{ variantId, quantity: 1 }]);
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
        orderLines.mockResolvedValue([{ variantId, quantity: 1 }]);
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
        orderLines.mockResolvedValue([{ variantId: "variant-tshirt-99", quantity: 1 }]);
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
        orderLines.mockResolvedValue([{ variantId, quantity: 1 }]);
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, noteAttributes: attrs({ Program_ID: String(programId), CheckMeIn_Account_ID: `${personId},${sibId}` }) })]);

        await runReconcile();
        expect(await statusOf(programId, personId)).toBe("PENDING");
        expect(await statusOf(programId, sibId)).toBe("PENDING");
        expect(await kinds(oid)).toEqual(["AMOUNT_MISMATCH"]);
    });

    it("activates everyone when the order buys a seat per person", async () => {
        const oid = `${TAG}-602`;
        const email = `ent-full-${TAG}@ex.com`;
        const { householdId, personId, programId, variantId } = await makeProgramEnrollment({ email, status: "PENDING" });
        const sibId = await addSibling(householdId, programId, email);
        orderLines.mockResolvedValue([{ variantId, quantity: 2 }]);
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, noteAttributes: attrs({ Program_ID: String(programId), CheckMeIn_Account_ID: `${personId},${sibId}` }) })]);

        await runReconcile();
        expect(await statusOf(programId, personId)).toBe("ACTIVE");
        expect(await statusOf(programId, sibId)).toBe("ACTIVE");
        expect(await kinds(oid)).toEqual([]);
    });

    it.each([
        ["PARTIALLY_REFUNDED", { financialStatus: "PARTIALLY_REFUNDED", totalRefundedCents: 1000 }],
        ["VOIDED", { financialStatus: "VOIDED" }],
        ["cancelled", { cancelledAt: new Date() }],
    ])("raises REVERSED_BEFORE_ACTIVATION and does not activate a %s order", async (label, over) => {
        const oid = `${TAG}-603-${label}`;
        const { personId, programId, variantId } = await makeProgramEnrollment({ email: `ent-rev-${label}-${TAG}@ex.com`, status: "PENDING" });
        orderLines.mockResolvedValue([{ variantId, quantity: 1 }]);
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, ...over, noteAttributes: attrs({ Program_ID: String(programId), CheckMeIn_Account_ID: String(personId) }) })]);

        await runReconcile();
        expect(await statusOf(programId, personId)).toBe("PENDING");
        expect(await kinds(oid)).toEqual(["REVERSED_BEFORE_ACTIVATION"]);
    });

    it("waits on an order not yet paid: no activation, no exception", async () => {
        const oid = `${TAG}-604`;
        const { personId, programId, variantId } = await makeProgramEnrollment({ email: `ent-unpaid-${TAG}@ex.com`, status: "PENDING" });
        orderLines.mockResolvedValue([{ variantId, quantity: 1 }]);
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, financialStatus: "PARTIALLY_PAID", noteAttributes: attrs({ Program_ID: String(programId), CheckMeIn_Account_ID: String(personId) }) })]);

        await runReconcile();
        expect(await statusOf(programId, personId)).toBe("PENDING");
        expect(await kinds(oid)).toEqual([]);
    });

    it("email fallback leaves a lead's merchandise order untouched", async () => {
        const oid = `${TAG}-605`;
        const email = `ent-merch-${TAG}@ex.com`;
        const { personId, programId } = await makeProgramEnrollment({ email, status: "PENDING" });
        orderLines.mockResolvedValue([{ variantId: "variant-tshirt-99", quantity: 1 }]);
        ordersChangedSince.mockResolvedValue([order({ legacyId: oid, customerEmail: email })]);

        await runReconcile();
        expect(await statusOf(programId, personId)).toBe("PENDING");
        expect(await kinds(oid)).toEqual([]);
    });

    it("email fallback activates when the order carries the pending program's variant", async () => {
        const oid = `${TAG}-606`;
        const email = `ent-fallback-${TAG}@ex.com`;
        const { personId, programId, variantId } = await makeProgramEnrollment({ email, status: "PENDING" });
        orderLines.mockResolvedValue([{ variantId, quantity: 1 }]);
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
});
