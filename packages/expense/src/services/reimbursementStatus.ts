// X12 callee: receipt asks when each reimbursement was paid. QuickBooks is the system of record;
// until QB-1/QB-2 read Bills and their BillPayments, every receipt answers "not yet paid".
import { z } from "zod";
import type { ReimbursementStatus } from "../contract";

export const reimbursementStatus: ReimbursementStatus = {
  async forReceipts(receiptIds) {
    const ids = z.array(z.string()).parse(receiptIds);
    return new Map(ids.map((id) => [id, { paidOn: null }]));
  },
};
