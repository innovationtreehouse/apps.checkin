/**
 * Income reconciliation queue items (every OPEN row, drift included, and any
 * row carrying an app note), for the Revenue Ops Income tab's pill. Reads
 * income's own database inside a request.
 */
import { reconciliationService } from "@checkin/income";
import { getOrg } from "@/lib/catalog/configure";

export async function incomeOpenCount(): Promise<number> {
  return reconciliationService.countQueue((await getOrg()).id);
}
