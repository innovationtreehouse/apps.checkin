// Which QuickBooks account types expense books to (docs/in-design/PER_ITEM_ACCOUNTS.md §7): a capital rule or
// line takes Fixed Asset, every other rule or line an expense type. Saves read QuickBooks live.
import { ServiceError } from "@checkin/component-kit";
import { LINE_ACCOUNT_TYPES, accountTypeRefusal } from "@checkin/quickbooks";
import { getExpenseRuntime } from "../runtime";

/** The types a rule or line books to: Fixed Asset only when it says it's capital. */
export const bookableTypes = (capital: boolean | null): readonly string[] => (capital ? LINE_ACCOUNT_TYPES.donatedCapital : LINE_ACCOUNT_TYPES.donatedGoods);

/** The types expense's QuickBooks account list admits: every type a rule or line may book to. */
export const LISTED_TYPES: readonly string[] = [...LINE_ACCOUNT_TYPES.donatedGoods, ...LINE_ACCOUNT_TYPES.donatedCapital];

/** Refuses (400) an account QuickBooks doesn't list under one of `allowed`; 503 while QuickBooks can't be read. */
export async function refuseWrongType(qbAccount: string, allowed: readonly string[], what: string): Promise<void> {
  const refusal = accountTypeRefusal(await getExpenseRuntime().quickbooks.accounts(), qbAccount, allowed, what);
  if (refusal) throw new ServiceError(400, refusal);
}
