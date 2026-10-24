// The QuickBooks entry an expense posts, composed from the rows the outbound gateway passed. No
// database: the poster reads the rows and the host's gateway strips them before this runs.
import type { TxnWrite } from "@checkin/quickbooks";
import type { ExpensePosting, OutboundBag } from "./contract";
import type { ExpenseLineItem } from "./db/schema";

export type LineAmounts = Pick<ExpenseLineItem, "totalPriceCents" | "allocatedTaxCents" | "allocatedShippingCents" | "allocatedDiscountCents">;

/** What a line posts: its price plus its share of tax and shipping, less its share of the discount. */
export function lineCents(l: LineAmounts): number {
  return l.totalPriceCents + (l.allocatedTaxCents ?? 0) + (l.allocatedShippingCents ?? 0) - (l.allocatedDiscountCents ?? 0);
}

export type Built = { write: TxnWrite; lineAccounts: Map<number, string> } | { queue: string } | { noClass: string } | { error: string };

type Row = Record<string, unknown>;

function isRow(v: unknown): v is Row {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rowsOf(v: unknown): Row[] {
  if (Array.isArray(v)) return v.filter(isRow);
  return isRow(v) ? [v] : [];
}

function text(r: Row | undefined, field: string): string | null {
  const v = r?.[field];
  return typeof v === "string" ? v : null;
}

function int(r: Row | undefined, field: string): number | null {
  const v = r?.[field];
  return typeof v === "number" ? v : null;
}

type WriteLineRow = { id: number; description: string; account: string | null; amountCents: number };

/** A line as the gateway passed it; null when a field the write needs did not pass. */
function writeLineRow(r: Row): WriteLineRow | null {
  const id = int(r, "id");
  const description = text(r, "description");
  const totalPriceCents = int(r, "totalPriceCents");
  if (id === null || description === null || totalPriceCents === null) return null;
  const amountCents = lineCents({
    totalPriceCents,
    allocatedTaxCents: int(r, "allocatedTaxCents"),
    allocatedShippingCents: int(r, "allocatedShippingCents"),
    allocatedDiscountCents: int(r, "allocatedDiscountCents"),
  });
  return { id, description, account: text(r, "resolvedQbAccount") || null, amountCents };
}

/** Each line's QuickBooks Class, from its budget bucket. */
function lineClasses(stripped: OutboundBag, lines: WriteLineRow[]): Map<number, string> | { noClass: string } {
  const bucketOf = new Map(rowsOf(stripped.LineItemOwnerApproval).map((a) => [int(a, "lineItemId"), int(a, "ownerId")]));
  const buckets = new Map(rowsOf(stripped.BudgetOwner).map((b) => [int(b, "id"), b]));
  const classes = new Map<number, string>();
  for (const l of lines) {
    const bucketId = bucketOf.get(l.id) ?? null;
    const bucket = bucketId === null ? undefined : buckets.get(bucketId);
    if (!bucket) return { noClass: `Line "${l.description}" has no budget bucket, so it has no QuickBooks Class` };
    const classId = text(bucket, "quickBooksClassId");
    if (!classId) {
      return { noClass: `Budget bucket '${text(bucket, "name")}' has no QuickBooks Class; set it on the Budgets page` };
    }
    classes.set(l.id, classId);
  }
  return classes;
}

/**
 * The entry to create, from the rows the outbound gateway passed; each line keeps its own account
 * and its bucket's Class. A field the write needs that did not pass fails the post.
 */
export function composeWrite(stripped: OutboundBag, posting: Pick<ExpensePosting, "paymentType" | "paymentAccountId">): Built {
  const [expense] = rowsOf(stripped.Expense);
  const txnDate = text(expense, "receiptDate");
  if (!txnDate) return { error: "the expense has no receipt date" };
  const needsReimbursement = expense?.needsReimbursement;
  if (typeof needsReimbursement !== "boolean") return { error: "the expense's reimbursement flag did not pass the outbound gateway" };
  const items = rowsOf(stripped.ExpenseLineItem);
  if (items.length === 0) return { error: "the expense has no lines" };
  const lines: WriteLineRow[] = [];
  for (const item of items) {
    const line = writeLineRow(item);
    if (!line) return { error: "a line's id, description or price did not pass the outbound gateway" };
    lines.push(line);
  }
  const unresolved = lines.find((l) => !l.account);
  if (unresolved) return { error: `line "${unresolved.description}" has no resolved QuickBooks account` };
  const accounts = new Map(lines.map((l) => [l.id, l.account!]));
  const classes = lineClasses(stripped, lines);
  if ("noClass" in classes) return classes;
  const writeLines = lines.map((l) => ({
    amountCents: l.amountCents,
    accountId: accounts.get(l.id)!,
    classId: classes.get(l.id)!,
    description: l.description,
  }));
  const memo = text(expense, "vendorName") ?? undefined;

  if (needsReimbursement) {
    const vendorId = text(rowsOf(stripped.ExpenseReimburseeVendor)[0], "qbVendorId");
    if (!vendorId) return { queue: "the reimbursee has no QuickBooks Vendor" };
    return { write: { entity: "Bill", fields: { txnDate, vendorId, lines: writeLines, memo } }, lineAccounts: accounts };
  }
  return {
    write: {
      entity: "Purchase",
      fields: { txnDate, paymentType: posting.paymentType, accountId: posting.paymentAccountId, lines: writeLines, memo },
    },
    lineAccounts: accounts,
  };
}
