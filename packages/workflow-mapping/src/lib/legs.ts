import { z } from "zod";
import type { ReceivedReceipt, ReceivedReceiptLineStatusRow } from "../db/schema";

/** The parts of a receipt an apply pushes: its money side (expense, or donation when in kind) and its inventory. */
export const APPLY_LEGS = ["expense", "donation", "inventory"] as const;
export type ApplyLeg = (typeof APPLY_LEGS)[number];

export const LEG_LABEL: Record<ApplyLeg, string> = { expense: "Expense", donation: "Donation", inventory: "Inventory" };

/** How a close-out settles a part that never applied. */
export const CLOSE_OUT_DISPOSITIONS = ["done_by_hand", "not_needed"] as const;
export type CloseOutDisposition = (typeof CLOSE_OUT_DISPOSITIONS)[number];

export const DISPOSITION_LABEL: Record<CloseOutDisposition, string> = { done_by_hand: "Done by hand", not_needed: "Not needed" };

export const CloseOutBodySchema = z.object({
  note: z.string({ error: "A note is required" }).trim().min(1, "A note is required"),
  legs: z.partialRecord(z.enum(APPLY_LEGS), z.enum(CLOSE_OUT_DISPOSITIONS)).default({}),
});
export type CloseOutBody = z.infer<typeof CloseOutBodySchema>;

type InventoryLineFields = Pick<ReceivedReceiptLineStatusRow, "recognitionStatus" | "assignedGtin13" | "provisionalItemGtin13">;

/** A line the inventory leg carries. */
export function isInventoryLine(ls: InventoryLineFields): boolean {
  if (ls.recognitionStatus === "provisional") return !!ls.provisionalItemGtin13;
  return ls.recognitionStatus === "recognized" && ls.assignedGtin13 != null;
}

type Stamps = { [K in "expenseAppliedAt" | "donationAppliedAt" | "inventoryAppliedAt"]: ReceivedReceipt[K] | string | null };

/** The legs this receipt pushes, each with whether it has applied. */
export function receiptLegs(
  receipt: Stamps,
  isInKind: boolean,
  lines: InventoryLineFields[],
): { leg: ApplyLeg; applied: boolean }[] {
  const money: ApplyLeg = isInKind ? "donation" : "expense";
  const legs: { leg: ApplyLeg; applied: boolean }[] = [
    { leg: money, applied: !!(isInKind ? receipt.donationAppliedAt : receipt.expenseAppliedAt) },
  ];
  if (lines.some(isInventoryLine)) legs.push({ leg: "inventory", applied: !!receipt.inventoryAppliedAt });
  return legs;
}
