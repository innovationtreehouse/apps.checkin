/**
 * Open income reconciliation items (every OPEN row, drift included), for the
 * Revenue Ops Income tab's pill. Reads income's own database inside a request.
 */
import { RECON_STATUS, reconciliationService } from "@inventory/income";
import { getOrg } from "@/lib/catalog/configure";

export async function incomeOpenCount(): Promise<number> {
  return reconciliationService.count((await getOrg()).id, RECON_STATUS.OPEN);
}
