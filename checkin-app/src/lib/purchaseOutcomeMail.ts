/**
 * The email telling a purchaser what became of their receipt: to its uploader, and separately to
 * the person reimbursed when that is someone else. It carries only what the recipient's own
 * receipt pages show, and never names the other recipient.
 */
import prisma from "@/lib/prisma";
import { config } from "@/lib/config";
import { sendTemplated } from "@/lib/email-templates/send";
import { LIVE_PERSON, SIGN_IN_VERIFIED_PERSON } from "@/lib/person/filters";

export type PurchaseOutcome = "receipt_rejected" | "expense_line_rejected" | "reimbursement_complete";

export type OutcomeRecipient = "uploader" | "reimbursee";

export interface PurchaseOutcomeNotice {
  receiptId: string;
  outcome: PurchaseOutcome;
  uploaderPersonId: number;
  reimburseePersonId: number | null;
  retailer: string | null;
  /** As the receipt stores it; a `YYYY-MM-DD` value is shown as a written date. */
  receiptDate: string | null;
}

const TEMPLATE = {
  receipt_rejected: "receipt.rejected",
  expense_line_rejected: "expense.lineRejected",
  reimbursement_complete: "expense.reimbursementComplete",
} as const;

const RECEIPT_WORDING: Record<OutcomeRecipient, string> = {
  uploader: "your receipt",
  reimbursee: "a receipt for your reimbursement",
};

/** The person a copy goes to, or null when that copy is owed to no one. */
export function recipientOf(notice: PurchaseOutcomeNotice, to: OutcomeRecipient): number | null {
  if (to === "uploader") return notice.uploaderPersonId;
  if (notice.reimburseePersonId === null || notice.reimburseePersonId === notice.uploaderPersonId) return null;
  return notice.reimburseePersonId;
}

/** Absent means on; turning off all email also stops these. */
export function wantsPurchaseOutcomes(notificationSettings: unknown): boolean {
  if (typeof notificationSettings !== "object" || notificationSettings === null) return true;
  const settings = notificationSettings as Record<string, unknown>;
  return settings.email !== false && settings.emailPurchaseOutcomes !== false;
}

function writtenDate(receiptDate: string | null): string {
  if (!receiptDate) return "—";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receiptDate)) return receiptDate;
  const d = new Date(`${receiptDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return receiptDate;
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * Sends one copy of an outcome notice. True when the copy is done: sent, owed to no one, or
 * the recipient has no verified address or has opted out. False when a send or lookup failed
 * and the copy should be retried.
 */
export async function sendPurchaseOutcome(notice: PurchaseOutcomeNotice, to: OutcomeRecipient): Promise<boolean> {
  const personId = recipientOf(notice, to);
  if (personId === null) return true;
  try {
    const person = await prisma.person.findFirst({
      where: { id: personId, ...LIVE_PERSON, ...SIGN_IN_VERIFIED_PERSON },
      select: { email: true, name: true, notificationSettings: true },
    });
    if (!person?.email) return true;
    if (!wantsPurchaseOutcomes(person.notificationSettings)) return true;
    return await sendTemplated(TEMPLATE[notice.outcome], person.email, {
      name: person.name,
      receipt: RECEIPT_WORDING[to],
      retailer: notice.retailer ?? "—",
      date: writtenDate(notice.receiptDate),
      actionLink: `${config.baseUrl()}/receipts/${encodeURIComponent(notice.receiptId)}`,
    });
  } catch (err) {
    console.error(`[purchase outcome] ${notice.outcome} for receipt ${notice.receiptId} not sent:`, err);
    return false;
  }
}
