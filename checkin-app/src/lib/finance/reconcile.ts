import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { config, DEV_MOCK_MEMBERSHIP_VARIANT_ID } from "@/lib/config";
import { activateByProcessId } from "@/lib/membership/payment";
import { notifyBoardPaymentException } from "@/lib/membership/boardAlerts";
import { unentitledMemberCodeUse } from "@/lib/programs/memberDiscountCode";
import { fromWhere } from "@/lib/programs/enrollmentState";
import * as mirror from "@/lib/shopifyRead/client";
import type { MirrorOrder } from "@/lib/shopifyRead/client";

/**
 * Shopify payment reconciler. Reads the s-read `shopify_read` mirror and aligns
 * Shopify order truth with membership/program truth, both directions:
 *
 *   forward  — a paid order whose family is still stuck at PENDING_PAYMENT is a
 *              MISSED orders/paid webhook: recover it (activate), advancing the
 *              family past the paid checkpoint. Application AND renewal.
 *   reversal — an order we already activated on that is later refunded, charged
 *              back, or cancelled: raise a PaymentException for the board. We never
 *              auto-revert access (a chargeback can be a bank error).
 *
 * Runs once daily from api/cron/reconcile-shopify (09:15 UTC, just behind s-read's
 * 09:00 sync — the cadence is a scale-to-zero constraint, see that route).
 * Idempotent: forward recovery is a no-op once activate() has recorded the order
 * (activate stores shopifyOrderId and short-circuits on paidAt), and every
 * exception upserts on (kind, order).
 *
 * Matching uses the SAME cart attribute the webhook credits — Membership_Process_ID
 * (or CheckMeIn_Account_ID + Program_ID), mirrored since #1029 — so attribution is
 * exact. Orders synced before that carry no attributes and fall back to customer
 * email → household lead → the family's single pending process.
 *
 * Membership recovery replicates the webhook's variant-id check that the order
 * really contains the membership product: the mirror's order lines carry variant
 * ids since #1048, so recovery gates on the order containing one of checkin's known
 * membership variants — the exact set the webhook builds — not on order total.
 * (Orders synced before #1048 and not yet backfilled carry no line variant ids;
 * those fall back to a discount-aware dues amount gate — see reconcileForwardMembership.)
 * Nothing is guessed: an attribute naming an unknown process, an ambiguous email
 * match, or an order with no membership item raises a problem for the board rather
 * than activating. One policy check rides on top of the variant gate: a
 * non-volunteer family redeeming the board's volunteer discount code raises
 * DISCOUNT_UNAUTHORIZED instead of activating (see usesVolunteerCodeUnentitled).
 *
 * The program side carries the parallel check, judged AT THE MONEY EVENT: a minted
 * `PRG{programId}-XXXXXXXX` member-discount code redeemed by a household that isn't
 * dues-settled through the program's coverage date raises the same
 * DISCOUNT_UNAUTHORIZED instead of activating. The orders/paid webhook asks it for a
 * live checkout; this forward pass asks it when recovering a missed webhook. The
 * reversal pass deliberately does NOT re-ask it: entitlement is a fact about the
 * moment money moved, so a household deactivated later never retro-flags orders that
 * were honest when they were paid (see unentitledMemberCodeUse).
 */

export type PaymentExceptionKind =
    | "PAID_WHILE_BLOCKED"
    | "NO_ITEM"
    | "UNMATCHED_ORDER"
    | "REFUND"
    | "CHARGEBACK"
    | "CANCELLED"
    | "REVERSED_BEFORE_ACTIVATION"
    | "AMOUNT_MISMATCH"
    | "ACTIVE_WITHOUT_PAYMENT"
    | "DISCOUNT_UNAUTHORIZED"
    | "PAYMENT_UNVERIFIABLE";

type Severity = "WARN" | "CRITICAL";

const CRITICAL_KINDS = new Set<PaymentExceptionKind>(["CHARGEBACK"]);

// A recovered payment may come in a cent or two under the recorded dues (rounding,
// a stale settings copy). Only a shortfall beyond this is a real mismatch.
const AMOUNT_TOLERANCE_CENTS = 100;

interface ExceptionRef {
    shopifyOrderId?: string | null;
    processId?: number | null;
    programId?: number | null;
    personId?: number | null;
    severity?: Severity;
}

/**
 * Upsert a PaymentException, idempotent across daily runs. One open row per
 * (kind, order); a resolved row that re-detects reopens (the problem came back). A
 * newly-opened or reopened row escalates to the board (CRITICAL emails immediately;
 * WARN is surfaced on the dashboard + red-dot only — see notifyBoardPaymentException).
 */
export async function raisePaymentException(kind: PaymentExceptionKind, ref: ExceptionRef): Promise<void> {
    const severity: Severity = ref.severity ?? (CRITICAL_KINDS.has(kind) ? "CRITICAL" : "WARN");
    const orderId = ref.shopifyOrderId ?? null;

    // Find an existing row for this (kind, order). When orderId is null the unique
    // index treats rows as distinct, so fall back to the linked entity.
    const existing = orderId
        ? await prisma.paymentException.findFirst({ where: { kind, shopifyOrderId: orderId } })
        : await prisma.paymentException.findFirst({
              where: { kind, shopifyOrderId: null, processId: ref.processId ?? null, programId: ref.programId ?? null, personId: ref.personId ?? null },
          });

    if (existing) {
        if (existing.status === "RESOLVED") {
            await prisma.paymentException.update({
                where: { id: existing.id },
                data: { status: "OPEN", severity, resolvedAt: null, resolvedById: null, resolutionNote: null, detectedAt: new Date() },
            });
            await notifyBoardPaymentException(kind, severity, existing.id);
        }
        return; // already tracked and still open/acknowledged — nothing to do.
    }

    try {
        const created = await prisma.paymentException.create({
            data: {
                kind,
                severity,
                shopifyOrderId: orderId,
                processId: ref.processId ?? null,
                programId: ref.programId ?? null,
                personId: ref.personId ?? null,
            },
        });
        await notifyBoardPaymentException(kind, severity, created.id);
    } catch (e: unknown) {
        // Unique-index race (two runs, same order) — the other run created it. Safe.
        if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "P2002") return;
        throw e;
    }
}

// ── predicates over a mirror order ───────────────────────────────────────────

/**
 * Shopify displayFinancialStatus that means "money is in" and not reversed.
 * Exported: matchAudit.ts must apply the SAME predicate, or the audit and the
 * reconciler disagree about which orders count as paid.
 */
export function isPaid(o: Pick<MirrorOrder, "financialStatus" | "cancelledAt" | "totalRefundedCents">): boolean {
    return (o.financialStatus ?? "").toUpperCase() === "PAID" && !o.cancelledAt && o.totalRefundedCents === 0;
}

/**
 * The membership variant-id set (BoardSettings variants + the dev-mock variant
 * when the Shopify mock is active) — the ONE "is this line a membership?" rule.
 * Exported so matchAudit.ts consumes the same set as the #1074 item gate; a
 * variant added here but missed in a private copy would silently VANISH from
 * the audit (filtered out in SQL), not show as a gap.
 */
export function membershipVariantIdSet(settings: {
    orgMembershipVariantId: string | null;
} | null): Set<string> {
    return new Set(
        [
            settings?.orgMembershipVariantId,
            config.shopifyMockActive() ? DEV_MOCK_MEMBERSHIP_VARIANT_ID : null,
        ].filter((v): v is string => !!v),
    );
}

/** Any sign the money came back out. Exported so matchAudit.ts marks reversed activations
 *  with the SAME predicate the reversal pass raises exceptions on. */
export function isReversed(o: Pick<MirrorOrder, "financialStatus" | "cancelledAt" | "totalRefundedCents">): boolean {
    const s = (o.financialStatus ?? "").toUpperCase();
    return !!o.cancelledAt || o.totalRefundedCents > 0 || s === "REFUNDED" || s === "PARTIALLY_REFUNDED" || s === "VOIDED";
}

/**
 * Volunteer-coupon entitlement check. Shopify owns the discount ARITHMETIC
 * (variant-backed orders are never amount-gated); checkin owns the POLICY that
 * only volunteer households may use the volunteer-rate code — the #1074 variant
 * gate correctly stopped flagging couponed orders by amount, which also meant a
 * non-volunteer family redeeming the volunteer code activated cleanly with no flag.
 *
 * True iff the order's mirrored coupon list carries the board-configured volunteer
 * code (BoardSettings.volunteerDiscountCode — the same code the checkout link
 * appends for volunteer households) while the membership is NOT volunteer. Compared
 * case-insensitively (Shopify codes are). An EMPTY discountCodes list is never
 * evidence of anything — rows synced before #1048 mirror no codes — so only a
 * non-empty list can flag. Other codes (promos) are Shopify's business, not ours.
 */
export function usesVolunteerCodeUnentitled(order: MirrorOrder, volunteerCode: string | null | undefined, isVolunteer: boolean): boolean {
    if (isVolunteer || !volunteerCode) return false;
    const vc = volunteerCode.trim().toUpperCase();
    if (!vc) return false;
    return order.discountCodes.some((c) => c.trim().toUpperCase() === vc);
}

// ── program entitlement (shared by the orders/paid webhook and this reconciler) ──

/** The order facts a program entitlement is judged on — built from the webhook
 *  payload or the mirror, so both paths judge the same thing. */
export interface EntitlementOrder extends Pick<MirrorOrder, "financialStatus" | "cancelledAt" | "totalRefundedCents"> {
    lines: { variantId: string; quantity: number }[];
}

/** ok, or the exception to raise; `kind: null` = not paid yet, raise nothing. */
export type Entitlement = { ok: true } | { ok: false; kind: PaymentExceptionKind | null };

/**
 * Does this order pay for activating these people in this program? Paid and not
 * reversed, carries the program's own variant, and buys at least one seat per
 * person still awaiting payment. A seat shortfall activates nobody: the order
 * cannot say which of the household it was meant for, so the board decides.
 */
export async function orderEntitlesEnrollment(order: EntitlementOrder, programId: number, personIds: number[]): Promise<Entitlement> {
    if (isReversed(order)) return { ok: false, kind: "REVERSED_BEFORE_ACTIVATION" };
    if (!isPaid(order)) return { ok: false, kind: null };

    const program = await prisma.program.findUnique({ where: { id: programId }, select: { shopifyVariantId: true } });
    const variantId = program?.shopifyVariantId;
    const seats = variantId ? order.lines.filter((l) => l.variantId === variantId).reduce((n, l) => n + l.quantity, 0) : 0;
    if (seats === 0) return { ok: false, kind: "NO_ITEM" };

    const awaiting = await prisma.programParticipant.count({ where: { programId, personId: { in: personIds }, ...fromWhere("PENDING_UNPAID") } });
    if (seats < awaiting) return { ok: false, kind: "AMOUNT_MISMATCH" };
    return { ok: true };
}

// ── forward pass (recover missed payments) ───────────────────────────────────

type ResolvedProcess = { id: number; orgMembershipId: number | null } | "none" | "ambiguous";

/**
 * Which membership process (if any) is this order paying for?
 *
 * Preferred: the `Membership_Process_ID` cart attribute the checkout link itself
 * set — mirrored since #1029, and the exact same key the orders/paid webhook
 * credits. Exact, so no ambiguity.
 *
 * Fallback: customer email → household lead → the family's single PENDING_PAYMENT
 * process. Only reached for orders synced before #1029 shipped (note_attributes is
 * null on those). Fuzzier, so it refuses to guess: zero or several pending
 * processes resolve to "none"/"ambiguous" rather than picking one.
 *
 * Either way the caller checks the order contains a membership variant before
 * activating (amount-gating only pre-#1048 orders), and only a PENDING_PAYMENT
 * process is ever a recovery candidate.
 */
async function resolveMembershipProcess(order: MirrorOrder): Promise<ResolvedProcess> {
    const raw = mirror.orderAttr(order, "Membership_Process_ID");
    if (raw) {
        const id = parseInt(raw, 10);
        if (isNaN(id)) return "ambiguous"; // tagged as a membership order, but unusably
        const p = await prisma.orgMembershipProcess.findUnique({
            where: { id },
            select: { id: true, status: true, orgMembershipId: true },
        });
        // Attribute names a process that doesn't exist — forged/replayed/stale. Never guess.
        if (!p) return "ambiguous";
        // It IS a membership order; it just isn't awaiting payment (already settled,
        // still in review, archived...). activate() would no-op — nothing to recover.
        if (p.status !== "PENDING_PAYMENT") return "none";
        return { id: p.id, orgMembershipId: p.orgMembershipId };
    }

    const email = order.customerEmail?.toLowerCase().trim();
    if (!email) return "none";
    const leads = await prisma.person.findMany({ where: { email, isHouseholdLead: true }, select: { householdId: true } });
    const householdIds = [...new Set(leads.map((l) => l.householdId))];
    if (householdIds.length === 0) return "none";

    const pending = await prisma.orgMembershipProcess.findMany({
        where: { orgMembership: { householdId: { in: householdIds } }, status: "PENDING_PAYMENT" },
        select: { id: true, orgMembershipId: true },
    });
    if (pending.length === 0) return "none"; // family has no membership awaiting payment.
    if (pending.length > 1) return "ambiguous"; // can't safely pick which one this paid for.
    return pending[0];
}

/**
 * Try to attribute one mirror order to a membership process and act on it. Returns
 * true if the order was claimed (recovered or raised), false if it is not a
 * membership order (so a program pass may still claim it).
 */
async function reconcileForwardMembership(order: MirrorOrder): Promise<boolean> {
    // Already recorded on a process? Then it is not a missed payment.
    if (order.legacyId) {
        const known = await prisma.orgMembershipProcess.findFirst({ where: { shopifyOrderId: order.legacyId }, select: { id: true } });
        if (known) return true;
    }

    const proc = await resolveMembershipProcess(order);
    if (proc === "none") return false; // not a membership order — a program pass may claim it.
    if (proc === "ambiguous") {
        await raisePaymentException("UNMATCHED_ORDER", { shopifyOrderId: order.legacyId });
        return true;
    }

    // Paid then reversed before we ever activated — keep it PENDING, tell the board.
    if (isReversed(order)) {
        await raisePaymentException("REVERSED_BEFORE_ACTIVATION", { shopifyOrderId: order.legacyId, processId: proc.id });
        return true;
    }
    if (!isPaid(order)) return true; // pending/authorized/etc — nothing to do yet, but it IS this family's order.

    // Membership-item gate, parity with the orders/paid webhook: recover only if the
    // order actually CONTAINS a membership product (its variant id), the same
    // membershipVariantIdSet the webhook builds — mirrored
    // onto order lines since #1048. A variant id is stable and can't drift; the old
    // total-price gate false-raised AMOUNT_MISMATCH on every couponed order (volunteer
    // rate, promo), whose sub-dues total is indistinguishable from an underpayment by
    // amount alone. See the H2 note in payment.ts and the webhook route.
    const settings = await prisma.boardSettings.findUnique({
        where: { id: 1 },
        select: {
            orgMembershipVariantId: true,
            standardMembershipFeeCents: true,
            volunteerMembershipFeeCents: true,
            volunteerDiscountCode: true,
        },
    });
    const membershipVariantIds = membershipVariantIdSet(settings ?? null);
    const lineVariantIds = await mirror.orderLineVariantIds(order.orderGid);
    // Both branches below need the membership's volunteer flag: the amount-gate
    // fallback for expected dues, the coupon entitlement check for volunteerOnly.
    const membership = proc.orgMembershipId
        ? await prisma.orgMembership.findUnique({ where: { id: proc.orgMembershipId }, select: { isVolunteer: true } })
        : null;

    if (lineVariantIds.length > 0) {
        // Post-#1048 order: variant ids are mirrored, so the item check is authoritative.
        if (!lineVariantIds.some((v) => membershipVariantIds.has(v))) {
            // Attributed to a pending process, paid, but no membership product on it —
            // the webhook's NO_ITEM case (activate() fails closed there).
            await raisePaymentException("NO_ITEM", { shopifyOrderId: order.legacyId, processId: proc.id });
            return true;
        }
    } else {
        // TRANSITIONAL (remove once the #1048 backfill re-pull is universal): rows
        // synced before #1048 carry no line variant ids, so the item check is
        // impossible — fall back to the old dues amount gate, made discount-aware by
        // adding the coupon back so a couponed pre-backfill order compares its GROSS
        // figure to gross dues and no longer false-raises AMOUNT_MISMATCH.
        const expected = membership?.isVolunteer ? settings?.volunteerMembershipFeeCents ?? 0 : settings?.standardMembershipFeeCents ?? 0;
        if (expected > 0 && order.totalCents + order.discountCents + AMOUNT_TOLERANCE_CENTS < expected) {
            await raisePaymentException("AMOUNT_MISMATCH", { shopifyOrderId: order.legacyId, processId: proc.id });
            return true;
        }
    }

    // Coupon entitlement: the item gates above prove the order carries the membership
    // product, but not that the family was ALLOWED the code that priced it. Volunteer
    // code on a non-volunteer membership → tell the board, do NOT activate (parity
    // with the NO_ITEM branch). Sits after both gates so a backfilled pre-#1048 row
    // with codes is covered too; pre-backfill rows mirror [] and pass through unjudged.
    if (usesVolunteerCodeUnentitled(order, settings?.volunteerDiscountCode, membership?.isVolunteer ?? false)) {
        logger.warn(`[reconcile] volunteer discount code on non-volunteer order ${order.legacyId} (process ${proc.id})`);
        await raisePaymentException("DISCOUNT_UNAUTHORIZED", { shopifyOrderId: order.legacyId, processId: proc.id });
        return true;
    }

    // Recover: advance past the paid checkpoint. hasMembershipItem=true — the order
    // contains a known membership variant (or, for a pre-backfill order, covers dues)
    // and is matched to this specific pending process (honest missed-webhook
    // assumption; the reconciler is not the attack surface the public webhook is, and
    // it leaves a full AuditLog trail via activate()).
    const result = await activateByProcessId(proc.id, order.legacyId ?? "", true);
    logger.info(`[reconcile] recovered missed payment: process ${proc.id} ← order ${order.legacyId} (${result?.status})`);
    if (result?.status === "BLOCKED") {
        await raisePaymentException("PAID_WHILE_BLOCKED", { shopifyOrderId: order.legacyId, processId: proc.id });
    }
    return true;
}

/**
 * Program forward recovery: a paid order whose enrollments are still PENDING is a
 * missed webhook. Judged by orderEntitlesEnrollment, the same check the webhook
 * makes. Returns true if claimed.
 */
async function reconcileForwardProgram(order: MirrorOrder): Promise<boolean> {
    if (order.legacyId) {
        const known = await prisma.programParticipant.findFirst({ where: { shopifyOrderId: order.legacyId }, select: { programId: true } });
        if (known) return true;
    }

    // Preferred: the cart attributes the enroll flow's checkout link set — the same
    // keys the orders/paid webhook credits. CheckMeIn_Account_ID is a comma-separated
    // person list, matching the webhook's own parse.
    const programRaw = mirror.orderAttr(order, "Program_ID");
    const accountRaw = mirror.orderAttr(order, "CheckMeIn_Account_ID");
    if (programRaw && accountRaw) {
        const programId = parseInt(programRaw, 10);
        const ids = accountRaw.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
        if (isNaN(programId) || ids.length === 0) {
            if (isPaid(order)) await raisePaymentException("UNMATCHED_ORDER", { shopifyOrderId: order.legacyId });
            return true;
        }
        // Only those actually awaiting payment; a redelivery/re-run finds none and no-ops.
        const pending = await prisma.programParticipant.findMany({
            where: { programId, personId: { in: ids }, status: "PENDING" },
            select: { personId: true },
        });
        if (pending.length === 0) return true; // it IS this program's order, nothing to recover.
        return activateProgramFromOrder(order, programId, pending.map((p) => p.personId));
    }

    // Fallback for orders without attributes: the purchaser (household lead) and
    // everyone in their household. Claims the order only when it carries a pending
    // program's own variant — anything else (merch, a donation) passes untouched.
    if (!isPaid(order)) return false;
    const email = order.customerEmail?.toLowerCase().trim();
    if (!email) return false;
    const leads = await prisma.person.findMany({ where: { email, isHouseholdLead: true }, select: { householdId: true } });
    const householdIds = [...new Set(leads.map((l) => l.householdId))];
    if (householdIds.length === 0) return false;

    const pending = await prisma.programParticipant.findMany({
        where: { person: { householdId: { in: householdIds } }, status: "PENDING" },
        select: { programId: true, personId: true, program: { select: { shopifyVariantId: true } } },
    });
    if (pending.length === 0) return false;

    const orderVariants = new Set((await mirror.orderLines(order.orderGid)).map((l) => l.variantId));
    const matched = pending.filter((p) => p.program.shopifyVariantId && orderVariants.has(p.program.shopifyVariantId));
    const programs = [...new Set(matched.map((p) => p.programId))];
    if (programs.length === 0) return false;
    if (programs.length > 1) {
        await raisePaymentException("UNMATCHED_ORDER", { shopifyOrderId: order.legacyId });
        return true;
    }

    return activateProgramFromOrder(order, programs[0], matched.map((p) => p.personId));
}

/** Shared tail for both program-matching paths: judge, then activate through the one choke point. */
async function activateProgramFromOrder(order: MirrorOrder, programId: number, personIds: number[]): Promise<boolean> {
    const entitlement = await orderEntitlesEnrollment({ ...order, lines: await mirror.orderLines(order.orderGid) }, programId, personIds);
    if (!entitlement.ok) {
        if (entitlement.kind) {
            logger.warn(`[reconcile] program order ${order.legacyId} not entitled (${entitlement.kind}, program ${programId}) — NOT activated`);
            await raisePaymentException(entitlement.kind, { shopifyOrderId: order.legacyId, programId, personId: personIds[0] ?? null });
        }
        return true;
    }

    // Coupon entitlement, parity with the membership forward branch above: the order
    // may well contain the program's product, but the member code on it is only honest
    // if some enrollee's household is dues-settled through the program's coverage date.
    // This IS the money event for a missed webhook — same judgement the webhook makes,
    // asked once. None entitled → tell the board, do NOT activate.
    if (await unentitledMemberCodeUse(programId, personIds, order.discountCodes, order.legacyId ?? null)) {
        logger.warn(`[reconcile] program member discount code on non-member order ${order.legacyId} (program ${programId})`);
        await raisePaymentException("DISCOUNT_UNAUTHORIZED", { shopifyOrderId: order.legacyId, programId, personId: personIds[0] ?? null });
        return true;
    }

    const { activateProgramEnrollment } = await import("@/lib/programs/activateEnrollment");
    const res = await activateProgramEnrollment({ programId, personIds, shopifyOrderId: order.legacyId ?? "" });
    logger.info(`[reconcile] recovered program payment: program ${programId} ← order ${order.legacyId} (${res.activatedCount} activated)`);
    return true;
}

// ── reversal pass (raise problems on money that came back out) ────────────────

function classifyReversal(o: MirrorOrder, disputed: boolean): PaymentExceptionKind | null {
    if (o.cancelledAt) return "CANCELLED";
    if (disputed) return "CHARGEBACK";
    if (isReversed(o)) return "REFUND";
    return null;
}

/**
 * Fast-path entry for the reversal webhooks (refunds/create, orders/cancelled,
 * disputes/*): map a Shopify order id to the membership process and/or program
 * enrollment it activated and raise the given problem. Returns true if anything
 * matched. Shares the same idempotent raise as the daily reconciler.
 */
export async function raiseReversalByOrderId(orderLegacyId: string, kind: PaymentExceptionKind): Promise<boolean> {
    let matched = false;
    const proc = await prisma.orgMembershipProcess.findFirst({ where: { shopifyOrderId: orderLegacyId }, select: { id: true } });
    if (proc) {
        await raisePaymentException(kind, { shopifyOrderId: orderLegacyId, processId: proc.id });
        matched = true;
    }
    const enrolls = await prisma.programParticipant.findMany({ where: { shopifyOrderId: orderLegacyId }, select: { programId: true, personId: true } });
    for (const e of enrolls) {
        await raisePaymentException(kind, { shopifyOrderId: orderLegacyId, programId: e.programId, personId: e.personId });
        matched = true;
    }
    return matched;
}

async function reconcileReversals(): Promise<number> {
    // App-side activated orders: money recorded (paidAt) with an order id. BLOCKED
    // stays out — a refund on a paid-while-blocked application is the expected fix.
    const procs = await prisma.orgMembershipProcess.findMany({
        where: { shopifyOrderId: { not: null }, paidAt: { not: null }, status: { in: ["ACTIVE", "PENDING_BG_CLEARANCE"] } },
        select: { id: true, shopifyOrderId: true, orgMembershipId: true },
    });
    const enrolls = await prisma.programParticipant.findMany({
        where: { shopifyOrderId: { not: null }, status: "ACTIVE" },
        select: { programId: true, personId: true, shopifyOrderId: true },
    });

    const orderIds = [
        ...procs.map((p) => p.shopifyOrderId!),
        ...enrolls.map((e) => e.shopifyOrderId!),
    ];
    if (orderIds.length === 0) return 0;

    const orders = await mirror.ordersByLegacyIds([...new Set(orderIds)]);
    const byLegacy = new Map(orders.map((o) => [o.legacyId ?? "", o]));
    const disputed = await mirror.disputedOrderGids(orders.map((o) => o.orderGid));

    // Expected dues per membership (for the "order edited down below dues" case).
    const settings = await prisma.boardSettings.findUnique({
        where: { id: 1 },
        select: { standardMembershipFeeCents: true, volunteerMembershipFeeCents: true, volunteerDiscountCode: true },
    });
    const memberIds = procs.map((p) => p.orgMembershipId).filter((v): v is number => v != null);
    const members = memberIds.length
        ? await prisma.orgMembership.findMany({ where: { id: { in: memberIds } }, select: { id: true, isVolunteer: true } })
        : [];
    const isVolunteerById = new Map(members.map((m) => [m.id, m.isVolunteer]));

    let raised = 0;
    for (const proc of procs) {
        const o = byLegacy.get(proc.shopifyOrderId!);
        if (!o) continue; // pre-cutover / not yet mirrored — can't judge.
        let kind = classifyReversal(o, disputed.has(o.orderGid));
        if (!kind) {
            // Not reversed — but was the order edited down below dues after activation?
            // Discount-aware: add the coupon back so an ordinary couponed order (volunteer
            // rate, promo) isn't mistaken for a post-activation edit-down — only a real
            // shortfall below GROSS dues counts. Keeps the "edited down" purpose intact.
            const expected = isVolunteerById.get(proc.orgMembershipId ?? -1) ? settings?.volunteerMembershipFeeCents ?? 0 : settings?.standardMembershipFeeCents ?? 0;
            if (expected > 0 && o.totalCents + o.discountCents + AMOUNT_TOLERANCE_CENTS < expected) kind = "AMOUNT_MISMATCH";
        }
        if (!kind && usesVolunteerCodeUnentitled(o, settings?.volunteerDiscountCode, isVolunteerById.get(proc.orgMembershipId ?? -1) ?? false)) {
            // Coupon entitlement, shared with the forward pass — and load-bearing here:
            // orders the webhook activated in real time never reach the forward pass
            // (already recorded on the process → early return), so this loop over
            // activated memberships is the daily audit that catches a volunteer code
            // a non-volunteer family redeemed. Order + volunteer flag already in hand.
            logger.warn(`[reconcile] volunteer discount code on non-volunteer activated order ${proc.shopifyOrderId} (process ${proc.id})`);
            kind = "DISCOUNT_UNAUTHORIZED";
        }
        if (kind) {
            await raisePaymentException(kind, { shopifyOrderId: proc.shopifyOrderId, processId: proc.id });
            raised++;
        }
    }
    for (const e of enrolls) {
        const o = byLegacy.get(e.shopifyOrderId!);
        if (!o) continue;
        // Money-out only. Member-code entitlement is NOT re-asked here: it was judged
        // when the money moved (webhook / forward pass), and this loop has no bound on
        // time — re-deriving it from live household state would raise a fresh flag on
        // every past member-priced order the morning after an ordinary deactivation.
        const kind = classifyReversal(o, disputed.has(o.orderGid));
        if (kind) {
            await raisePaymentException(kind, { shopifyOrderId: e.shopifyOrderId, programId: e.programId, personId: e.personId });
            raised++;
        }
    }
    return raised;
}

// ── entry point ──────────────────────────────────────────────────────────────

export interface ReconcileResult {
    configured: boolean;
    ordersScanned: number;
    reversalsRaised: number;
    /** Orders whose forward pass threw. The cron route surfaces it as the run's
     *  health signal (lib/cronAuth.ts) — isolating a bad order keeps the sweep
     *  going and the run still counts as having RUN, but it is not clean. Do not
     *  reuse this key for anything else: withCron reads `failed` by name. */
    failed: number;
}

/**
 * One reconciliation pass. No-op (configured:false) when the mirror isn't wired.
 * Advances BoardSettings.shopifyReconcileCursorAt to the newest order it processed
 * so the next run only re-scans changed orders.
 */
export async function runReconcile(): Promise<ReconcileResult> {
    if (!mirror.isConfigured()) return { configured: false, ordersScanned: 0, reversalsRaised: 0, failed: 0 };

    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 }, select: { shopifyReconcileCursorAt: true } });
    const cursor = settings?.shopifyReconcileCursorAt ?? null;

    const orders = await mirror.ordersChangedSince(cursor);
    let newCursor = cursor;
    // Stop advancing the cursor at the first order whose pass throws: advancing past
    // it would skip that order FOREVER (the forward pass is cursor-once). Later
    // orders in this batch still get processed (idempotent, so re-scanning them
    // tomorrow is harmless); only the watermark holds back until the bad order heals.
    let cursorFrozen = false;
    let failed = 0;
    for (const order of orders) {
        try {
            const claimed = await reconcileForwardMembership(order);
            if (!claimed) await reconcileForwardProgram(order);
        } catch (e) {
            logger.error(`[reconcile] forward pass failed for order ${order.legacyId ?? order.orderGid}:`, e);
            failed++;
            cursorFrozen = true;
            // The watermark may ALREADY sit at this order's updatedAt — an earlier
            // order in the batch with the same timestamp succeeded and advanced it.
            // ordersChangedSince compares with a strict `updated_at >`, so leaving
            // the cursor there would skip this order forever. Pull it back below
            // the failed order so the next run re-fetches it.
            if (order.updatedAt && newCursor && newCursor >= order.updatedAt) {
                newCursor = new Date(order.updatedAt.getTime() - 1);
            }
        }
        if (!cursorFrozen && order.updatedAt && (!newCursor || order.updatedAt > newCursor)) newCursor = order.updatedAt;
    }

    const reversalsRaised = await reconcileReversals();

    // Advance the cursor only after a clean pass, so a mid-run failure re-scans.
    if (newCursor && newCursor !== cursor) {
        await prisma.boardSettings.update({ where: { id: 1 }, data: { shopifyReconcileCursorAt: newCursor } });
    }

    return { configured: true, ordersScanned: orders.length, reversalsRaised, failed };
}
