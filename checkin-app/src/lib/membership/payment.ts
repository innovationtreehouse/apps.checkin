import prisma from "@/lib/prisma";
import { ServiceError } from "@checkin/component-kit";
import { PAYMENT_ERROR_STATUS } from "@/lib/domainErrorResponse";
import { hasHouseholdConflict } from "@/lib/conflictOfInterest";
import { emailHouseholdLeads } from "@/lib/emailRecipients";
import { logBackendError, logger } from "@/lib/logger";
import { notifyBoardPaidReject } from "@/lib/membership/boardAlerts";
import { runClearanceStep } from "@/lib/membership/clearanceSteps";
import { config, DEV_MOCK_MEMBERSHIP_VARIANT_ID } from "@/lib/config";
import { systemActor, personOrSystemActor } from "@/lib/auditActor";
import { asHouseholdProcess, fromWhere, openProcess } from "@/lib/membership/lifecycle";
import { variantSaleState, type VariantSaleState } from "@/lib/shopify/products";
import { setHouseholdStatus, raiseDeniedHouseholdActivity, type HouseholdStatus } from "@/lib/membership/householdStatus";
import { isOrderReversed } from "@/lib/finance/reconcile/exceptions";
import { recordUnreportedReversal } from "@/lib/finance/reconcile/liveOrder";
import { applicationYear, endedPaymentPlanYearRefusal, membershipYearEnded, membershipYearLabel } from "@/lib/programYear";
import { orgToday } from "@/lib/appSettings";
import { householdHasDisputedCheck } from "@/lib/membership/checkStanding";
import type { Prisma } from "@/generated/prisma/client";
import { lockProcessRows } from "@/lib/lockOrder";

// Loaded on use: settleHouseholdBg imports review.ts, and a static import closes that cycle at load.
const settleModule = () => import("@/lib/membership/settleHouseholdBg");

/**
 * Payment phase (PENDING_PAYMENT -> ACTIVE).
 *
 * Every household pays through its application's membership year's Shopify
 * variant (a MembershipYearVariant row). Volunteer households get the
 * board's discount code appended to that link so Shopify applies their discount
 * at checkout — our membership fee figures are only what applicants *see*. The membership
 * process id rides along as a cart attribute so the orders/paid webhook can
 * match the payment back to this application. Payment (orders/paid webhook) OR a
 * board manual-payment override both converge on activate(): one place
 * that flips the membership ACTIVE, records how, and sends one congrats email.
 */


export class PaymentError extends ServiceError {
    constructor(public readonly code: "not_found" | "wrong_phase" | "forbidden", message: string) {
        super(PAYMENT_ERROR_STATUS[code], message, code);
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
 * The variant a checkout for membership year `year` sells: that year's row, else the dev mock
 * variant while the Shopify mock is active, else null. Never another year's row.
 */
export async function yearVariantId(year: number | null): Promise<string | null> {
    const row = year === null ? null : await prisma.membershipYearVariant.findUnique({ where: { membershipYear: year }, select: { shopifyVariantId: true } });
    return row?.shopifyVariantId ?? (config.shopifyMockActive() ? DEV_MOCK_MEMBERSHIP_VARIANT_ID : null);
}

/** Why a checkout can't be built for an application's year: the year ended, it has no product, or the store couldn't be asked. */
type Unavailable = "ended" | "no_product" | "unreachable";

/** What the family's payment page shows in place of a link for an application for `year`. */
export function paymentUnavailableMessage(year: number, why: Unavailable): string {
    if (why === "ended") return `This application is for ${membershipYearLabel(year)}, which has ended. Please contact the Board.`;
    if (why === "unreachable") return "We couldn't reach the store to build your payment link. Please try again in a few minutes.";
    return `Payment for ${membershipYearLabel(year)} isn't available right now. Please contact the Board.`;
}

/** A membership year's product the Board must fix before families with an application for that year can pay. */
export type MembershipProductProblem = { year: number; cause: "missing" | "retired" | "unreachable"; message: string };

/**
 * Whether membership year `year` has a product a checkout can sell: its variant row, and
 * outside the mock, a Shopify variant whose product is not archived. Null when it does.
 */
async function yearProductProblem(year: number): Promise<MembershipProductProblem | null> {
    const label = membershipYearLabel(year);
    const variantId = await yearVariantId(year);
    if (!variantId) {
        return { year, cause: "missing", message: `There is no ${label} membership product in the membership settings. Families with a ${label} application can't pay until one is set.` };
    }
    if (config.shopifyMockActive()) return null;
    let state: VariantSaleState;
    try {
        state = await variantSaleState(variantId);
    } catch (error) {
        logger.error(`Shopify lookup of the ${label} membership variant failed:`, error);
        return { year, cause: "unreachable", message: `Shopify couldn't be reached to check the ${label} membership product. Families with a ${label} application may not be able to pay; reload to check again.` };
    }
    if (state === "sellable") return null;
    const what = state === "archived" ? "is archived in Shopify" : "no longer exists in Shopify";
    return { year, cause: "retired", message: `The ${label} membership product ${what}. Families with a ${label} application can't pay until it is restored.` };
}

/**
 * Each running membership year an unpaid household application is for whose product
 * can't be sold, for the Board's chip. Nothing with no boundary set.
 */
export async function membershipProductProblems(): Promise<MembershipProductProblem[]> {
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 }, select: { orgMembershipYearBoundary: true } });
    const boundary = settings?.orgMembershipYearBoundary;
    if (!boundary) return [];
    const today = await orgToday();
    const unpaid = await prisma.orgMembershipProcess.findMany({
        where: { kind: { in: ["INITIAL", "RENEWAL"] }, paidAt: null, ...openProcess.where },
        select: { membershipYear: true, createdAt: true },
    });
    const years = [...new Set(unpaid.map((p) => applicationYear(p, boundary)))]
        .filter((y): y is number => y !== null && !membershipYearEnded(y, boundary, today))
        .sort((a, b) => a - b);
    const problems = await Promise.all(years.map(yearProductProblem));
    return problems.filter((p): p is MembershipProductProblem => p !== null);
}

export type PaymentLink = { amountCents: number; checkoutUrl: string | null; unavailable: string | null };

/**
 * Resolve the membership fee amount and the Shopify checkout link for a process in
 * PENDING_PAYMENT. The link sells the application's own year's variant, with the
 * volunteer discount code appended for volunteer households. An application whose
 * year has ended, or whose year has no product, gets no link and says why. With no
 * boundary or store domain configured, returns the amount with a null link.
 */
export async function ensurePaymentLink(processId: number): Promise<PaymentLink> {
    const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
    if (!proc) throw new PaymentError("not_found", "Application not found.");
    if (proc.status !== "PENDING_PAYMENT") throw new PaymentError("wrong_phase", "This application is not awaiting payment.");

    const membership = await prisma.orgMembership.findUnique({ where: { id: asHouseholdProcess(proc).orgMembershipId }, select: { isVolunteerFamily: true } });
    if (!membership) throw new PaymentError("not_found", "Membership not found.");

    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
    const amountCents = membership.isVolunteerFamily ? settings?.volunteerMembershipFeeCents ?? 0 : settings?.standardMembershipFeeCents ?? 0;

    const boundary = settings?.orgMembershipYearBoundary;
    const year = applicationYear(proc, boundary);
    if (year === null || !boundary) return { amountCents, checkoutUrl: null, unavailable: null };
    if (membershipYearEnded(year, boundary, await orgToday())) {
        return { amountCents, checkoutUrl: null, unavailable: paymentUnavailableMessage(year, "ended") };
    }
    const storeDomain = config.shopifyStoreDomain();
    const variantId = await yearVariantId(year);
    if (!variantId) return { amountCents, checkoutUrl: null, unavailable: paymentUnavailableMessage(year, "no_product") };
    if (!storeDomain) return { amountCents, checkoutUrl: null, unavailable: null };
    const problem = await yearProductProblem(year);
    if (problem) return { amountCents, checkoutUrl: null, unavailable: paymentUnavailableMessage(year, problem.cause === "unreachable" ? "unreachable" : "no_product") };

    // Anyone holding this code can redeem it; reconciliation flags unentitled use afterwards.
    const discountCode = membership.isVolunteerFamily ? settings?.volunteerFamilyDiscountCode ?? null : null;
    return { amountCents, checkoutUrl: buildMembershipCheckoutUrl(storeDomain, variantId, processId, discountCode), unavailable: null };
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
 * `boundary` goes with `requireRequested`: the request's own year is then read
 * under the row lock and certified in place of `appliesToYear`. It also goes with
 * `acknowledgeYearMismatch`: a Board-named year that differs from the application's
 * own year is refused unless that is true. A payment-plan approval is never refused
 * for a mismatch.
 */
type SettleOpts = { via: "payment" | "manual"; actorId?: number; shopifyOrderId?: string; hasMembershipItem?: boolean; reason?: string; appliesToYear?: number | null; grantedYear?: number; requireRequested?: boolean; acknowledgeYearMismatch?: boolean; boundary?: Date | null };

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
    | "denied"
    | "refunded";

/**
 * The single payment path. Records the payment (paidAt + how), then gates on the
 * background check: if it has already cleared (bgClearedAt set), flip the
 * household ACTIVE and send one congrats email; otherwise hold the process at
 * PENDING_BG_CLEARANCE until two reviewers approve (review.ts › clearBackgroundCheck).
 * An application whose agreement is unsigned never activates here: it is held at
 * PENDING_EXTERNAL_ACTION, and signing it moves it on (external.ts › advanceExternalIfComplete).
 *
 * FOR UPDATE on the membership row, then the process row, in the order
 * lib/lockOrder.ts states, serializes against the review path's attest()
 * transaction and a board deny, and every status write is still conditional on
 * the status it read.
 *
 * - A board certify (via "manual") must find the process awaiting payment under
 *   the lock; otherwise it throws. With `requireRequested` it must also find the
 *   payment-plan request still open, and closes it in the write that settles, so
 *   a racing denial and this approval cannot both take effect.
 * - A refunded, cancelled or disputed order records nothing (`refunded`); the board is told.
 * - A DENIED household changes nothing; the board is told.
 * - BLOCKED records a real membership payment (stays BLOCKED, refund needed).
 * - A Shopify order without the membership product records nothing (`no_item`),
 *   so a later clearance can never activate an unpaid application.
 * - Any other paid order — duplicate, after certify, after close, before payment
 *   was due — records nothing and returns `nothing_due`.
 *
 * Recording a payment records the membership year it bought, on BLOCKED too: a
 * board reset and clearance can still activate that row.
 */
async function settle(
    processId: number,
    opts: SettleOpts,
): Promise<{ outcome: ActivateOutcome; householdId?: number; disputed?: boolean }> {
    if (opts.shopifyOrderId) await recordUnreportedReversal(opts.shopifyOrderId);
    // An application's membership is fixed at its creation, so this unlocked read stays true.
    const ref = await prisma.orgMembershipProcess.findUnique({ where: { id: processId }, select: { orgMembershipId: true } });
    const today = await orgToday();
    const result = await prisma.$transaction(async (tx) => {
        // Membership, then application: the order lib/lockOrder.ts states. The membership
        // lock keeps a deny from committing between the DENIED check and the payment write.
        const [membership] = ref?.orgMembershipId
            ? await tx.$queryRaw<{ householdId: number; status: HouseholdStatus }[]>`SELECT "householdId", status FROM "OrgMembership" WHERE id = ${ref.orgMembershipId} FOR UPDATE`
            : [];
        await lockProcessRows(tx, [processId]);
        const found = await tx.orgMembershipProcess.findUnique({ where: { id: processId } });
        if (!found) throw new PaymentError("not_found", "Application not found.");
        const process = asHouseholdProcess(found);
        if (!membership) throw new PaymentError("not_found", "Membership not found.");

        let appliesToYear = opts.appliesToYear ?? null;
        const appliedForYear = applicationYear(process, opts.boundary);
        let yearMismatch = false;
        if (opts.via === "manual") {
            if (opts.requireRequested && !(process.isPaymentPlanRequested && process.status === "PENDING_PAYMENT")) {
                throw new PaymentError("wrong_phase", "No pending payment-plan request");
            }
            if (opts.requireRequested) {
                if (process.paymentPlanYear === null) {
                    throw new PaymentError("wrong_phase", "This request has no membership year. Deny it; the family can ask again.");
                }
                appliesToYear = process.paymentPlanYear;
                const ended = endedPaymentPlanYearRefusal(process.paymentPlanYear, opts.boundary, today);
                if (ended) throw new PaymentError("wrong_phase", ended);
            } else if (appliesToYear !== null && appliedForYear !== null && appliesToYear !== appliedForYear) {
                if (!opts.acknowledgeYearMismatch) {
                    throw new PaymentError("wrong_phase", yearMismatchRefusal(appliedForYear, appliesToYear));
                }
                yearMismatch = true;
            }
            if (process.paidAt) throw new PaymentError("wrong_phase", "This application is already paid.");
            if (process.status !== "PENDING_PAYMENT") {
                throw new PaymentError("wrong_phase", "This application is not awaiting payment.");
            }
            if (membership.status === "DENIED") {
                throw new PaymentError("wrong_phase", "This household is denied. Restore it before recording a payment.");
            }
        }

        if (opts.shopifyOrderId && process.shopifyOrderId === opts.shopifyOrderId) return { outcome: "noop" as const };
        if (opts.shopifyOrderId && (await isOrderReversed(tx, opts.shopifyOrderId))) return { outcome: "refunded" as const };
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
        const closesRequest = opts.via === "manual" && opts.requireRequested === true;
        const approvalAudit = closesRequest ? { paymentPlanApproved: true, isPaymentPlanRequested: false } : {};
        const isGrant = opts.via === "manual" && opts.grantedYear !== undefined;
        const grantAudit = {
            ...(isGrant ? { grantedYear: opts.grantedYear, reason: opts.reason ?? null } : {}),
            ...(opts.via === "manual" ? { appliesToYear, membershipYear: appliedForYear, ...(yearMismatch ? { acknowledgeYearMismatch: true } : {}) } : {}),
        };

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
                data: { paidAt: now, appliesToYear, ...payMeta },
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

        // Every adult's standing is re-read under the locks: a rejection since the check
        // was stamped holds the payment unactivated, and settle then blocks it.
        const disputed = !!process.bgClearedAt && (await householdHasDisputedCheck(tx, membership.householdId));
        // An unsigned application never activates: it is held at the agreement step, whose signing advances it.
        const unsigned = !process.contractSignedAt;
        const activating = !!process.bgClearedAt && !disputed && !unsigned;
        const heldAt = unsigned ? "PENDING_EXTERNAL_ACTION" : "PENDING_BG_CLEARANCE";
        if (activating) {
            const applied = await setHouseholdStatus(tx, process.orgMembershipId, {
                from: ["NONE", "REVOKED", "ACTIVE"],
                to: "ACTIVE",
                actor,
                reason: `application #${processId} paid (${opts.via}) with background check cleared`,
            });
            if (!applied) return { outcome: "denied" as const, householdId: membership.householdId };
        }
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: { id: processId, ...fromWhere("PENDING_PAYMENT"), paidAt: null, ...(closesRequest ? { isPaymentPlanRequested: true } : {}) },
            // Leaving PENDING_PAYMENT ends any payment-plan request, approved or not.
            data: { paidAt: now, stageEnteredAt: now, appliesToYear, ...payMeta, status: activating ? "ACTIVE" : heldAt, isPaymentPlanRequested: false, ...(disputed ? { bgClearedAt: null } : {}) },
        });
        // Under the row lock the status can't have moved; if it did, roll the household write back.
        if (count === 0) throw new PaymentError("wrong_phase", "This application is not awaiting payment.");
        await tx.auditLog.create({
            data: {
                ...actor,
                action: "EDIT",
                tableName: "OrgMembershipProcess",
                affectedEntityId: processId,
                ...(isGrant ? { secondaryAffectedEntity: membership.householdId } : {}),
                oldData: { status: process.status },
                newData: activating
                    ? { status: "ACTIVE", via: opts.via, ...(certificationNote ? { certificationNote } : {}), ...approvalAudit, ...grantAudit }
                    : { status: heldAt, via: opts.via, paid: true, ...(unsigned ? { contractSigned: false } : {}), ...(disputed ? { bgCleared: false, reason: "a person in the household has a disputed background check" } : {}), ...(certificationNote ? { certificationNote } : {}), ...approvalAudit, ...grantAudit },
            },
        });
        return activating
            ? { outcome: "active" as const, householdId: membership.householdId, isInitial: process.kind === "INITIAL" }
            : { outcome: "held" as const, ...(disputed ? { householdId: membership.householdId, disputed } : {}) };
    });

    // Side effects outside the transaction: a slow/failed send must not roll back
    // the write, and only the call that actually recorded the change emits one.
    if (result.outcome === "active" && "isInitial" in result) {
        const { householdId, isInitial } = result;
        await afterActivationCommitted("congrats email", processId, householdId, () => sendCongrats(householdId, isInitial));
        // A brand-new (INITIAL) member just activated: open PERSON_BG for the
        // household's check-obligated adults, and the per-adult agreements. A failed
        // trigger becomes a stuck item on the Problems list.
        if (isInitial) {
            const asOf = new Date();
            await runClearanceStep("PERSON_BG_TRIGGER", { processId, householdId, shopifyOrderId: null, asOf });
            await runClearanceStep("PERSON_AGREEMENT_TRIGGER", { processId, householdId, shopifyOrderId: null, asOf });
        }
    }
    if (result.outcome === "denied") {
        await raiseDeniedHouseholdActivity({
            householdId: result.householdId!,
            processId,
            what: `Shopify membership payment (order ${opts.shopifyOrderId || "?"}) on application #${processId}`,
        });
    }
    if (result.outcome === "paid_while_blocked") await notifyBoardPaidReject(processId);
    if ("disputed" in result && result.disputed && result.householdId !== undefined) {
        const { householdId } = result;
        await (await settleModule()).settleAfterEvent(householdId, "payment", {}, { processId });
    }
    return result;
}

/**
 * Runs a step whose failure must not change what the settlement reports: the payment
 * has committed, and a retry finds it already recorded, so a throw would only report a
 * saved payment as failed.
 */
async function afterActivationCommitted(step: string, processId: number, householdId: number, run: () => Promise<unknown>): Promise<void> {
    try {
        await run();
    } catch (error) {
        const context = { processId, householdId };
        logger.error(`activation ${step} failed:`, context, error);
        await logBackendError(error, `activation ${step}`, context);
    }
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
    opts: SettleOpts,
) {
    await settle(processId, opts);
    return prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
}

/** The refusal for a Board-named year that differs from the application's own, unacknowledged. */
export function yearMismatchRefusal(appliedFor: number, paidFor: number): string {
    return `This application is for ${membershipYearLabel(appliedFor)}. You are recording a payment for ${membershipYearLabel(paidFor)}. Confirm the year doesn't match the application to continue.`;
}

type CertifyOpts =
    | { year: number; reason?: string; acknowledgeYearMismatch?: boolean; grant?: boolean; requireRequested?: never }
    | { requireRequested: true; reason?: string };

/**
 * Board override: certify a payment plan and activate without a Shopify payment.
 * Rejects (403) an actor who is not a Board member (a sysadmin is not enough) and
 * the actor's own household; activate() rejects (409) under the row lock unless
 * the process is awaiting payment. Records the Board-named `year`; `grant` marks
 * it as the grant action's. `requireRequested` makes this the decision on an open
 * payment-plan request (see settle), which records the request's stored year and
 * refuses one that has none or has ended.
 */
export async function certifyPaymentPlan(processId: number, actorId: number, opts: CertifyOpts) {
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
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 }, select: { orgMembershipYearBoundary: true } });
    const boundary = settings?.orgMembershipYearBoundary;
    if (opts.requireRequested) {
        return activate(processId, { via: "manual", actorId, reason: opts.reason, requireRequested: true, boundary });
    }
    return activate(processId, {
        via: "manual",
        actorId,
        reason: opts.reason,
        appliesToYear: opts.year,
        grantedYear: opts.grant ? opts.year : undefined,
        acknowledgeYearMismatch: opts.acknowledgeYearMismatch,
        boundary,
    });
}

/** An order's membership line and the year it buys; the year is null when no boundary is set. */
export type MembershipLine = { appliesToYear: number | null };

/** Shopify path (webhook + reconcile): settle a paid order and say what it did. A null line means no membership product. */
export async function activateByProcessId(processId: number, shopifyOrderId: string, line: MembershipLine | null) {
    const { outcome } = await settle(processId, { via: "payment", shopifyOrderId, hasMembershipItem: line !== null, appliesToYear: line?.appliesToYear });
    return { outcome, process: await prisma.orgMembershipProcess.findUnique({ where: { id: processId } }) };
}

/**
 * Send the one "your membership is active" email to a household's leads. A
 * renewal gets thanked for renewing — welcoming a family that has been here for
 * years reads as if we don't know them.
 */
export async function sendCongrats(householdId: number, isInitial: boolean) {
    await emailHouseholdLeads(
        householdId,
        isInitial ? "membership.welcome" : "membership.renewed",
        { actionLink: config.baseUrl() },
        "Congrats email failed:",
    );
}
