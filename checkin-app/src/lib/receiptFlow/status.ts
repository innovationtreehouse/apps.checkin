/**
 * The receipt flow status page's counts: how many records each library holds in each state.
 * FINANCE and BOARD get every section; an inventory manager gets receiving alone
 * (docs/rules/inventory.md, Access). A section is null when its library has no database here.
 */
import { expenseStateCounts } from "@checkin/expense";
import { receiptStateCounts } from "@checkin/receipt";
import { receivingStateCounts } from "@checkin/workflow-mapping";
import type { Role } from "@/security/core";

export interface StateCount {
  state: string;
  label: string;
  count: number;
}

export interface ReceiptFlowStatus {
  asOf: string;
  receipt?: { states: StateCount[]; notDelivered: number } | null;
  receiving: { states: StateCount[] } | null;
  expense?: { states: StateCount[] } | null;
}

/** The views GET /api/receipt-flow/status admits. */
export type ReceiptFlowRole = "isFinance" | "isBoardMember" | "isInventoryManager";

export function isReceiptFlowRole(role: Role): role is ReceiptFlowRole {
  return role === "isFinance" || role === "isBoardMember" || role === "isInventoryManager";
}

const configured = (envVar: string) => Boolean(process.env[envVar]);

export async function receiptFlowStatus(role: ReceiptFlowRole): Promise<ReceiptFlowStatus> {
  const everySection = role === "isFinance" || role === "isBoardMember";
  const [receipt, receiving, expense] = await Promise.all([
    everySection && configured("RECEIPT_DATABASE_URL") ? receiptStateCounts() : null,
    configured("WORKFLOW_MAPPING_DATABASE_URL") ? receivingStateCounts() : null,
    everySection && configured("EXPENSE_DATABASE_URL") ? expenseStateCounts() : null,
  ]);
  const asOf = new Date().toISOString();
  const receivingSection = receiving && { states: receiving };
  if (!everySection) return { asOf, receiving: receivingSection };
  return { asOf, receipt, receiving: receivingSection, expense: expense && { states: expense } };
}
