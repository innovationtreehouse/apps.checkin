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

    // Backfilled: paid on the date of the hand-booked transaction the receipt matched. A
    // receipt with no entity type stays unpaid: QuickBooks ids are unique per entity type only.
    const handBooked = asks.filter((a) => a.qbTxnId);
    const byEntity = (entity: string) => handBooked.filter((a) => a.qbEntity === entity).map((a) => a.qbTxnId as string);
    const handDates = new Map<string, string>([
      ...(await reader.purchasesByIds(byEntity("Purchase"))).map((t) => [`Purchase:${t.id}`, t.txnDate] as const),
      ...(await reader.billsByIds(byEntity("Bill"))).map((t) => [`Bill:${t.id}`, t.txnDate] as const),
    ]);
    for (const a of handBooked) paid.set(a.receiptId, { paidOn: handDates.get(`${a.qbEntity}:${a.qbTxnId}`) ?? null });

    // Booked by the system: a Bill the app never pays; paid once finance's BillPayments clear it.
    const orgId = await getOrgId();
    const booked = await db.expense.findMany({
      where: { orgId, id: { in: asks.filter((a) => !a.qbTxnId).map((a) => a.receiptId) }, qbTxnEntity: "Bill", qbTxnId: { not: null } },
      select: { id: true, qbTxnId: true },
    });
    const bills = await reader.billsByIds(booked.map((e) => e.qbTxnId as string));
    const settled = bills.filter((b) => b.balance === 0 && b.paymentIds.length > 0);
    const paymentDates = new Map(
      (await reader.billPaymentsByIds([...new Set(settled.flatMap((b) => b.paymentIds))])).map((p) => [p.id, p.txnDate]),
    );
    const billPaidOn = new Map(
      settled.map((b) => [b.id, latest(b.paymentIds.flatMap((id) => paymentDates.get(id) ?? []))]),
    );
    for (const e of booked) paid.set(e.id, { paidOn: billPaidOn.get(e.qbTxnId as string) ?? null });
    return paid;
  },
};
