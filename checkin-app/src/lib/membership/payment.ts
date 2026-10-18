import prisma from "@/lib/prisma";
import { hasHouseholdConflict } from "@/lib/conflictOfInterest";
import { emailHouseholdLeads } from "@/lib/emailRecipients";
import { notifyBoardPaidReject } from "@/lib/membership/boardAlerts";
import { openPersonBgForNewMember } from "@/lib/membership/personBgTriggers";
import { openPersonAgreementForNewMember } from "@/lib/membership/personAgreementTriggers";
import { config } from "@/lib/config";
import { systemActor, personOrSystemActor } from "@/lib/auditActor";
import { fromWhere } from "@/lib/membership/lifecycle";
import { setHouseholdStatus, raiseDeniedHouseholdActivity, type HouseholdStatus } from "@/lib/membership/householdStatus";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Payment phase (PENDING_PAYMENT -> ACTIVE).
 *
 * Every household pays through the same Shopify membership product (its
 * checkout permalink is set in BoardSettings). Volunteer households get the
 * board's discount code appended to that link so Shopify applies their discount
 * at checkout — our membership fee figures are only what applicants *see*. The membership
 * process id rides along as a cart attribute so the orders/paid webhook can
 * match the payment back to this application. Payment (orders/paid webhook) OR a
 * board manual-payment override both converge on activate(): one place
 * that flips the membership ACTIVE, records how, and sends one congrats email.
 */


export class PaymentError extends Error {
    constructor(public readonly code: "not_found" | "wrong_phase" | "forbidden", message: string) {
        super(message);
        this.name = "PaymentError";
    }
}

/**
 * Build the Shopify cart-permalink checkout link for a membership process. Both
 * tiers point at the same product variant; volunteers get `discount=<code>`
 * appended so Shopify applies their discount at checkout. The process id rides
 * along as a cart attribute (`attributes[Membership_Process_ID]`) so the
 * orders/paid webhook can match the payment back to this application.
 */
export function buildMembershipCheckoutUrl(
    storeDomain: string,
    variantId: string,
    processId: number,
    discountCode: string | null,
): string {
    const parts: string[] = [];
    if (discountCode) parts.push(`discount=${encodeURIComponent(discountCode)}`);
    parts.push(`attributes[Membership_Process_ID]=${processId}`);
    return `https://${storeDomain}/cart/${variantId}:1?${parts.join("&")}`;
}

/**
 * Resolve the membership fee amount and the Shopify checkout link for a process in
 * PENDING_PAYMENT. The link is built from SHOPIFY_STORE_DOMAIN +
 * BoardSettings.orgMembershipVariantId, with the volunteer discount code appended
 * for volunteer households. If the store domain or variant isn't configured,
 * returns the amount with a null link.
 */
export async function ensurePaymentLink(processId: number): Promise<{ amountCents: number; checkoutUrl: string | null }> {
    const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
    if (!proc) throw new PaymentError("not_found", "Application not found.");
    if (proc.status !== "PENDING_PAYMENT") throw new PaymentError("wrong_phase", "This application is not awaiting payment.");

    // orgMembershipId is non-null for any process in PENDING_PAYMENT (a PERSON_BG
    // never enters payment); the guard above ensures we only reach here for those.
    const membership = await prisma.orgMembership.findUnique({ where: { id: proc.orgMembershipId! }, select: { isVolunteer: true } });
    if (!membership) throw new PaymentError("not_found", "Membership not found.");

    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
    const amountCents = membership.isVolunteer ? settings?.volunteerMembershipFeeCents ?? 0 : settings?.standardMembershipFeeCents ?? 0;

    const variantId = settings?.orgMembershipVariantId;
    const storeDomain = config.shopifyStoreDomain();
    if (!variantId || !storeDomain) return { amountCents, checkoutUrl: null };

    // TODO(#278): the code is appended to a public cart link, so entitlement is
    // currently honor-system — nothing stops a non-volunteer from reusing it, and
    // the orders/paid webhook does not validate it (see
    // api/webhooks/shopify/route.ts). Long-term: gate the coupon to an
    // auto-managed Shopify customer segment of volunteer households so Shopify
    // enforces who can redeem it.
    const discountCode = membership.isVolunteer ? settings?.volunteerDiscountCode ?? null : null;
    return { amountCents, checkoutUrl: buildMembershipCheckoutUrl(storeDomain, variantId, processId, discountCode) };
}

/** Resolve the caller's household PENDING_PAYMENT process and ensure its payment link. */
export async function ensurePaymentLinkForUser(userId: number) {
    const user = await prisma.person.findUnique({ where: { id: userId }, select: { householdId: true } });
    if (!user?.householdId) throw new PaymentError("not_found", "You are not in a household.");
    const process = await prisma.orgMembershipProcess.findFirst({
        where: { orgMembership: { householdId: user.householdId }, status: "PENDING_PAYMENT" },
        orderBy: { id: "desc" },
    });
    if (!process) throw new PaymentError("wrong_phase", "No application is awaiting payment.");
    return ensurePaymentLink(process.id);
}

/**
 * What a payment did. `noop` is a redelivery of the order already recorded;
 * every other non-settling outcome is money that landed on nothing awaiting it,
 * which the webhook and the reconciler raise for the board.
 */
export type ActivateOutcome =
    | "active"
    | "held"
    | "noop"
    | "paid_while_blocked"
    | "no_item"
    | "nothing_due"
    | "denied";

/**
 * The single payment path. Records the payment (paidAt + how), then gates on the
 * background check: if it has already cleared (bgClearedAt set), flip the
 * household ACTIVE and send one congrats email; otherwise hold the process at
 * PENDING_BG_CLEARANCE until two reviewers approve (review.ts › clearBackgroundCheck).
 *
 * FOR UPDATE on the process row, then the household row, serializes against the
 * review path's attest() transaction and a board deny, and every status write is
 * still conditional on the status it read.
 *
 * - A board certify (via "manual") must find the process awaiting payment under
 *   the lock; otherwise it throws.
 * - A DENIED household changes nothing; the board is told.
 * - BLOCKED records a real membership payment (stays BLOCKED, refund needed).
 * - A Shopify order without the membership product records nothing (`no_item`),
 *   so a later clearance can never activate an unpaid application.
 * - Any other paid order — duplicate, after certify, after close, before payment
 *   was due — records nothing and returns `nothing_due`.
 */
async function settle(
    processId: number,
    opts: { via: "payment" | "manual"; actorId?: number; shopifyOrderId?: string; hasMembershipItem?: boolean; reason?: string },
): Promise<{ outcome: ActivateOutcome; householdId?: number }> {
    const result = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "OrgMembershipProcess" WHERE id = ${processId} FOR UPDATE`;
        const process = await tx.orgMembershipProcess.findUnique({ where: { id: processId } });
        if (!process) throw new PaymentError("not_found", "Application not found.");
        // Household row locked after the process row (the order review.ts takes), so a
        // deny can't commit between this DENIED check and the payment write.
        // orgMembershipId is non-null for a payable process (PERSON_BG has no checkout).
        const [membership] = await tx.$queryRaw<{ householdId: number; status: HouseholdStatus }[]>`SELECT "householdId", status FROM "OrgMembership" WHERE id = ${process.orgMembershipId!} FOR UPDATE`;
        if (!membership) throw new PaymentError("not_found", "Membership not found.");

        if (opts.via === "manual") {
            if (process.status !== "PENDING_PAYMENT" || process.paidAt) {
                throw new PaymentError("wrong_phase", "This application is not awaiting payment.");
            }
            if (membership.status === "DENIED") {
                throw new PaymentError("wrong_phase", "This household is denied. Restore it before recording a payment.");
            }
        }

        if (opts.shopifyOrderId && process.shopifyOrderId === opts.shopifyOrderId) return { outcome: "noop" as const };
        // DENIED before "already paid": any money reaching a denied household goes to the Board as DENIED activity.
        if (membership.status === "DENIED") return { outcome: "denied" as const, householdId: membership.householdId };
        if (process.paidAt || process.status === "ACTIVE") return { outcome: "nothing_due" as const };

        const now = new Date();
        const certificationNote = opts.via === "manual" && opts.reason && opts.reason.trim() !== "" ? opts.reason : undefined;
        const payMeta = {
            ...(opts.shopifyOrderId ? { shopifyOrderId: opts.shopifyOrderId } : {}),
            ...(opts.via === "manual" && opts.actorId ? { manualPaymentById: opts.actorId } : {}),
            ...(certificationNote ? { certificationNote } : {}),
        };
        const actor = personOrSystemActor(opts.actorId, "webhook:shopify-order");
        const missingItem = opts.via === "payment" && opts.hasMembershipItem === false;

        if (process.status === "BLOCKED") {
            // Checked before stamping paidAt: a board reset of a paid BLOCKED row
            // goes to PENDING_BG_CLEARANCE, and clearance would then activate it.
            if (missingItem) {
                await auditNoItem(tx, processId, "BLOCKED", opts.shopifyOrderId);
                return { outcome: "no_item" as const };
            }
            // Stays BLOCKED (stageEnteredAt untouched); refund needed.
            const { count } = await tx.orgMembershipProcess.updateMany({
                where: { id: processId, ...fromWhere("BLOCKED"), paidAt: null },
                data: { paidAt: now, ...payMeta },
            });
            if (count === 0) return { outcome: "nothing_due" as const };
            await tx.auditLog.create({
                data: {
                    ...actor,
                    action: "EDIT",
                    tableName: "OrgMembershipProcess",
                    affectedEntityId: processId,
                    oldData: { status: "BLOCKED" },
                    newData: { status: "BLOCKED", via: opts.via, paid: true, refundNeeded: true },
                },
            });
            return { outcome: "paid_while_blocked" as const };
        }

        // A checkout link exists only at PENDING_PAYMENT; money for any other step was not due.
        if (process.status !== "PENDING_PAYMENT") return { outcome: "nothing_due" as const };

        // The order must contain the membership product, checked by variant id
        // (stable; the id the checkout link is built from), not by total. A board
        // certify has no order and is exempt.
        if (missingItem) {
            await auditNoItem(tx, processId, "PENDING_PAYMENT", opts.shopifyOrderId);
            return { outcome: "no_item" as const };
        }

        const activating = !!process.bgClearedAt;
        if (activating) {
            const applied = await setHouseholdStatus(tx, process.orgMembershipId!, {
                from: ["NONE", "REVOKED", "ACTIVE"],
                to: "ACTIVE",
                actor,
                reason: `application #${processId} paid (${opts.via}) with background check cleared`,
            });
            if (!applied) return { outcome: "denied" as const, householdId: membership.householdId };
        }
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: { id: processId, ...fromWhere("PENDING_PAYMENT"), paidAt: null },
            data: { paidAt: now, stageEnteredAt: now, ...payMeta, status: activating ? "ACTIVE" : "PENDING_BG_CLEARANCE" },
        });
        // Under the row lock the status can't have moved; if it did, roll the household write back.
        if (count === 0) throw new PaymentError("wrong_phase", "This application is not awaiting payment.");
        await tx.auditLog.create({
            data: {
                ...actor,
                action: "EDIT",
                tableName: "OrgMembershipProcess",
                affectedEntityId: processId,
                oldData: { status: process.status },
                newData: activating
                    ? { status: "ACTIVE", via: opts.via, ...(certificationNote ? { certificationNote } : {}) }
                    : { status: "PENDING_BG_CLEARANCE", via: opts.via, paid: true, ...(certificationNote ? { certificationNote } : {}) },
            },
        });
        return activating
            ? { outcome: "active" as const, householdId: membership.householdId, isInitial: process.kind === "INITIAL" }
            : { outcome: "held" as const };
    });

    // Side effects outside the transaction: a slow/failed send must not roll back
    // the write, and only the call that actually recorded the change emits one.
    if (result.outcome === "active" && "isInitial" in result) {
        await sendCongrats(result.householdId, result.isInitial);
        // A brand-new (INITIAL) member just activated: open PERSON_BG for the
        // household's check-obligated adults, and the per-adult agreements.
        if (result.isInitial) await openPersonBgForNewMember(result.householdId, new Date());
        if (result.isInitial) await openPersonAgreementForNewMember(result.householdId, new Date());
    }
    if (result.outcome === "denied") {
        await raiseDeniedHouseholdActivity({
            householdId: result.householdId!,
            processId,
            what: `Shopify membership payment (order ${opts.shopifyOrderId || "?"}) on application #${processId}`,
        });
    }
    if (result.outcome === "paid_while_blocked") await notifyBoardPaidReject(processId);
    return result;
}

async function auditNoItem(tx: Prisma.TransactionClient, processId: number, status: "BLOCKED" | "PENDING_PAYMENT", shopifyOrderId?: string) {
    await tx.auditLog.create({
        data: {
            ...systemActor("webhook:shopify-order"),
            action: "EDIT",
            tableName: "OrgMembershipProcess",
            affectedEntityId: processId,
            oldData: { status },
            newData: { status, via: "payment", noMembershipItem: true, shopifyOrderId: shopifyOrderId ?? null },
        },
    });
}

/** Record a payment against a process (see settle). Returns the process row. */
export async function activate(
    processId: number,
    opts: { via: "payment" | "manual"; actorId?: number; shopifyOrderId?: string; hasMembershipItem?: boolean; reason?: string },
) {
    await settle(processId, opts);
    return prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
}

/**
 * Board override: certify a payment plan and activate without a Shopify payment.
 * Rejects (403) an actor who is not a Board member (a sysadmin is not enough) and
 * the actor's own household; activate() rejects (409) under the row lock unless
 * the process is awaiting payment.
 */
export async function certifyPaymentPlan(processId: number, actorId: number, opts?: { reason?: string }) {
    // Only the Board certifies a payment (owner ruling 10-15). Checked here so every
    // caller (grant, renewal grant, payment-plan approve, certify-payment) is covered.
    const actor = await prisma.person.findUnique({ where: { id: actorId }, select: { isBoardMember: true } });
    if (!actor?.isBoardMember) {
        throw new PaymentError("forbidden", "Only a Board member can certify a payment.");
    }
    const process = await prisma.orgMembershipProcess.findUnique({ where: { id: processId }, select: { orgMembership: { select: { householdId: true } } } });
    if (!process) throw new PaymentError("not_found", "Application not found.");
    // No actor may certify (mark paid + activate) their own household's membership. No role bypasses this.
    if (await hasHouseholdConflict(prisma, actorId, process.orgMembership?.householdId)) {
        throw new PaymentError("forbidden", "You cannot certify your own household's membership — someone outside your household must.");
    }
    return activate(processId, { via: "manual", actorId, reason: opts?.reason });
}

/** Shopify path (webhook + reconcile): settle a paid order and say what it did. */
export async function activateByProcessId(processId: number, shopifyOrderId: string, hasMembershipItem: boolean) {
    const { outcome } = await settle(processId, { via: "payment", shopifyOrderId, hasMembershipItem });
    return { outcome, process: await prisma.orgMembershipProcess.findUnique({ where: { id: processId } }) };
}

/**
 * Send the one "your membership is active" email to a household's leads. A
 * renewal gets thanked for renewing — welcoming a family that has been here for
 * years reads as if we don't know them.
 */
export async function sendCongrats(householdId: number, isInitial: boolean) {
    const base = config.baseUrl();
    const subject = isInitial
        ? "Welcome to the Treehouse — your membership is active!"
        : "Thank you for renewing — your Treehouse membership is active!";
    const lead = isInitial
        ? "Congratulations! Your household membership is now active. Welcome to the Innovation Treehouse community."
        : "Thank you for renewing! Your household membership is active again — we're glad to have your family back at the Innovation Treehouse.";
    await emailHouseholdLeads(
        householdId,
        subject,
        `<p>${lead}</p><p><a href="${base}">Visit your dashboard</a></p>`,
        "Congrats email failed:",
    );
}
