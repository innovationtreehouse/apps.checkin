// Which QuickBooks account each gift-of-goods line debits (docs/rules/expenses.md): finance's hand-set
// account, else the expense account rule for its part. A line with neither, or whose account can't
// be used, holds the gift for finance.
import { LINE_ACCOUNT_TYPES, type QboAccount } from "@checkin/quickbooks";

export interface LineToBook {
  id: number;
  description: string;
  valueCents: number;
  gtin13: string | null;
  quickBooksAccountId: string | null;
}

export type RuledAccount = { accountId: string } | { reason: string };

/** Why the account can't take this line, or null when it can. */
function unusable(accountId: string, capital: boolean, qb: readonly Pick<QboAccount, "Id" | "FullyQualifiedName" | "AccountType" | "Active">[]): string | null {
  const account = qb.find((a) => a.Id === accountId);
  if (!account) return `account ${accountId} is not in QuickBooks`;
  if (account.Active === false) return `${account.FullyQualifiedName} is inactive`;
  const allowed: readonly string[] = capital ? LINE_ACCOUNT_TYPES.donatedCapital : LINE_ACCOUNT_TYPES.donatedGoods;
  if (account.AccountType && allowed.includes(account.AccountType)) return null;
  return `${account.FullyQualifiedName} is ${account.AccountType ?? "of no type"}; ${capital ? "donated equipment" : "a donated item"} takes ${allowed.join(", ")}`;
}

/** Each line's account, or finance's note naming every line that holds the gift and why. */
export function lineAccounts(
  lines: readonly LineToBook[],
  capital: ReadonlySet<number>,
  ruled: ReadonlyMap<number, RuledAccount>,
  qb: readonly Pick<QboAccount, "Id" | "FullyQualifiedName" | "AccountType" | "Active">[],
): Map<number, string> | string {
  const accounts = new Map<number, string>();
  const held: string[] = [];
  for (const l of lines) {
    const rule = ruled.get(l.id);
    const accountId = l.quickBooksAccountId ?? (rule && "accountId" in rule ? rule.accountId : null);
    const why = accountId
      ? unusable(accountId, capital.has(l.id), qb)
      : !l.gtin13
        ? "it has no GTIN-13"
        : rule && "reason" in rule
          ? rule.reason
          : "no account rule was read for it";
    if (why || !accountId) held.push(`${l.description}: ${why}`);
    else accounts.set(l.id, accountId);
  }
  return held.length === 0 ? accounts : `Set an account on each held line, or an account rule for its part; the next run books the gift. ${held.join("; ")}`;
}
