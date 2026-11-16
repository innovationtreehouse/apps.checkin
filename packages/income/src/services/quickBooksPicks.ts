import { LINE_ACCOUNT_TYPES, accountTypeRefusal, type QboAccountSummary } from "@checkin/quickbooks";
import { db } from "../db";
import { getOrgId } from "../runtime";

/**
 * Each item account that `accounts` lacks, shows as inactive, or lists under a type a store sale can't book to, one line per item
 * naming the screen where finance re-picks it, for System Status. Stored values stay as they are.
 */
export async function misTypedQuickBooksPicks(accounts: readonly QboAccountSummary[]): Promise<string[]> {
  const items = await db.incomeItemCategory.findMany({
    where: { orgId: await getOrgId(), quickBooksAccountId: { not: null } },
    select: { variantId: true, quickBooksAccountId: true },
    orderBy: { variantId: "asc" },
  });
  return items.flatMap(({ variantId, quickBooksAccountId }) => {
    const refusal = quickBooksAccountId && accountTypeRefusal(accounts, quickBooksAccountId, LINE_ACCOUNT_TYPES.storeSale, "An item's account");
    return refusal ? [`Income items, variant ${variantId}: ${refusal}`] : [];
  });
}
