import prisma from "@/lib/prisma";
import { notifyBoardPaymentException } from "@/lib/membership/boardAlerts";
import { isPrismaError } from "@/lib/prismaUniqueViolation";
import { systemActor } from "@/lib/auditActor";
import type { DbClient, TxClient } from "@/lib/db-client";

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
    | "PAYMENT_UNVERIFIABLE"
    | "DENIED_HOUSEHOLD_ACTIVITY"
    | "DUPLICATE_PAYMENT"
    | "UNCLAIMED_SEATS"
    | "MIXED_HOUSEHOLDS";

type Severity = "WARN" | "CRITICAL";

const CRITICAL_KINDS = new Set<PaymentExceptionKind>(["CHARGEBACK"]);

interface ExceptionRef {
    shopifyOrderId?: string | null;
    processId?: number | null;
    programId?: number | null;
    personId?: number | null;
    severity?: Severity;
}

/**
 * Upsert a PaymentException, idempotent across daily runs. One open row per
 * (kind, order, person); a resolved row that re-detects reopens (the problem came back). A
 * newly-opened or reopened row escalates to the board (CRITICAL emails immediately;
 * WARN is surfaced on the dashboard + red-dot only — see notifyBoardPaymentException).
 */
export async function raisePaymentException(kind: PaymentExceptionKind, ref: ExceptionRef): Promise<void> {
    const severity: Severity = ref.severity ?? (CRITICAL_KINDS.has(kind) ? "CRITICAL" : "WARN");
    const orderId = ref.shopifyOrderId ?? null;

    // Find an existing row for this (kind, order, person). When orderId is null the
    // unique index treats rows as distinct, so fall back to the linked entity.
    const existing = orderId
        ? await prisma.paymentException.findFirst({ where: { kind, shopifyOrderId: orderId, personId: ref.personId ?? null } })
        : await prisma.paymentException.findFirst({
              where: { kind, shopifyOrderId: null, processId: ref.processId ?? null, programId: ref.programId ?? null, personId: ref.personId ?? null },
          });

    if (existing) {
        if (existing.status !== "RESOLVED" && severity === "CRITICAL" && existing.severity !== "CRITICAL") {
            await prisma.paymentException.update({ where: { id: existing.id }, data: { severity } });
            await notifyBoardPaymentException(kind, severity, existing.id);
            return;
        }
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
        if (isPrismaError(e, "P2002")) return;
        throw e;
    }
}

/** Problems that mean the order's money went back to the payer. */
const REVERSAL_KINDS: PaymentExceptionKind[] = ["REFUND", "CANCELLED", "CHARGEBACK", "REVERSED_BEFORE_ACTIVATION"];

/** Audit-log ledger of every reversal seen on an order. The Board cannot resolve it away. */
const REVERSAL_LEDGER_TABLE = "ShopifyOrderReversal";

const ledgerRow = (db: DbClient, shopifyOrderId: string) =>
    db.auditLog.findFirst({
        where: { tableName: REVERSAL_LEDGER_TABLE, newData: { path: ["shopifyOrderId"], equals: shopifyOrderId } },
        select: { id: true },
    });

/** Two-argument advisory-lock class, apart from FACILITY_ADVISORY_CLASS and REFUND_SETTLEMENT_ADVISORY_CLASS. */
export const ORDER_REVERSAL_ADVISORY_CLASS = 3;

/** Serializes a reversal being recorded on an order with a payment or clearance reading it. */
const lockOrderReversal = (tx: TxClient, shopifyOrderId: string) =>
    tx.$executeRaw`SELECT pg_advisory_xact_lock(${ORDER_REVERSAL_ADVISORY_CLASS}::int, hashtext(${shopifyOrderId}))`;

/**
 * Remember that an order was refunded, cancelled or disputed, once per order, so
 * no later payment or clearance activates a membership on it.
 */
export async function recordReversal(shopifyOrderId: string, kind: PaymentExceptionKind): Promise<void> {
    await prisma.$transaction(async (tx) => {
        await lockOrderReversal(tx, shopifyOrderId);
        if (await ledgerRow(tx, shopifyOrderId)) return;
        await tx.auditLog.create({
            data: {
                ...systemActor("webhook:shopify-refund"),
                action: "CREATE",
                tableName: REVERSAL_LEDGER_TABLE,
                affectedEntityId: 0,
                newData: { shopifyOrderId, kind },
            },
        });
    });
}

/**
 * True when the order's money went back: a reversal in the ledger, or an
 * unresolved reversal problem on it. A refunded order never activates a
 * membership; the Board decides instead. Takes the order's reversal lock, so a
 * refund recorded concurrently is either seen here or waits for this transaction
 * to commit (and then finds the process by the order id it wrote).
 */
export async function isOrderReversed(tx: TxClient, shopifyOrderId: string): Promise<boolean> {
    await lockOrderReversal(tx, shopifyOrderId);
    if (await ledgerRow(tx, shopifyOrderId)) return true;
    const open = await tx.paymentException.findFirst({
        where: { shopifyOrderId, kind: { in: REVERSAL_KINDS }, status: { not: "RESOLVED" } },
        select: { id: true },
    });
    return !!open;
}
