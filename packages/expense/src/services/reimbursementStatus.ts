// X12 callee: receipt asks when each reimbursement was paid. QuickBooks is the system of record.
import { z } from "zod";
import type { ReimbursementStatus } from "../contract";
import { db } from "../db";
import { getExpenseRuntime, getOrgId } from "../runtime";

const asksSchema = z.array(
  z.object({
    receiptId: z.string(),
    qbEntity: z.string().nullable().optional(),
    qbTxnId: z.string().nullable().optional(),
  }),
);

const latest = (dates: string[]): string | null => (dates.length ? dates.reduce((a, b) => (b > a ? b : a)) : null);

export const reimbursementStatus: ReimbursementStatus = {
  async forReceipts(receipts) {
    const asks = asksSchema.parse(receipts);
    const paid = new Map<string, { paidOn: string | null }>(asks.map((a) => [a.receiptId, { paidOn: null }]));
    if (asks.length === 0) return paid;
    const { reader } = getExpenseRuntime().quickbooks;

    // Backfilled: the hand-booked transaction the receipt matched. A receipt with no entity
    // type stays unpaid: QuickBooks ids are unique per entity type only.
    const handBooked = asks.filter((a) => a.qbTxnId);
    const byEntity = (entity: string) => handBooked.filter((a) => a.qbEntity === entity).map((a) => a.qbTxnId as string);

    // Booked by the system: a Bill the app never pays.
    const orgId = await getOrgId();
    const booked = await db.expense.findMany({
      where: { orgId, id: { in: asks.filter((a) => !a.qbTxnId).map((a) => a.receiptId) }, qbTxnEntity: "Bill", qbTxnId: { not: null } },
      select: { id: true, qbTxnId: true },
    });

    // Any Bill is paid once BillPayments clear it, on the latest payment's date.
    const bills = await reader.billsByIds([...new Set([...byEntity("Bill"), ...booked.map((e) => e.qbTxnId as string)])]);
    const settled = bills.filter((b) => b.balance === 0 && b.paymentIds.length > 0);
    const paymentDates = new Map(
      (await reader.billPaymentsByIds([...new Set(settled.flatMap((b) => b.paymentIds))])).map((p) => [p.id, p.txnDate]),
    );
    const billPaidOn = new Map(
      settled.map((b) => [b.id, latest(b.paymentIds.flatMap((id) => paymentDates.get(id) ?? []))]),
    );

    // A Purchase is paid at creation, on its own date.
    const purchasePaidOn = new Map((await reader.purchasesByIds(byEntity("Purchase"))).map((t) => [t.id, t.txnDate]));
    const handPaidOn = (a: (typeof asks)[number]) =>
      (a.qbEntity === "Bill" ? billPaidOn : a.qbEntity === "Purchase" ? purchasePaidOn : undefined)?.get(a.qbTxnId as string) ?? null;
    for (const a of handBooked) paid.set(a.receiptId, { paidOn: handPaidOn(a) });
    for (const e of booked) paid.set(e.id, { paidOn: billPaidOn.get(e.qbTxnId as string) ?? null });
    return paid;
  },
};
