import { accountTypeRefusal, type QboAccountSummary } from "@checkin/quickbooks";
import { db } from "../db";
import { getOrgId } from "../runtime";
import { LISTED_TYPES, bookableTypes } from "../lib/account-types";
import { IN_QUICKBOOKS, WAITING_ON_FINANCE } from "./holdService";

const withPlace = (place: string, refusal: string | null) => refusal && `${place}: ${refusal}`;

/**
 * Each stored QuickBooks pick that `accounts` lacks or lists under a type it doesn't accept, one line per pick
 * naming the screen where finance re-picks it, for System Status. Stored values stay as they are.
 */
export async function misTypedQuickBooksPicks(accounts: readonly QboAccountSummary[]): Promise<string[]> {
  const orgId = await getOrgId();
  const [listed, rules, held] = await Promise.all([
    db.expenseQbAccount.findMany({ where: { orgId }, select: { name: true, qbAccount: true }, orderBy: { name: "asc" } }),
    db.accountMapping.findMany({
      where: { orgId },
      select: { category: true, subcategory: true, partNumber: true, isCapital: true, qbAccount: true },
      orderBy: { id: "asc" },
    }),
    // Only lines finance may still re-pick, by setHeldLineAccount's gate, on an expense that still books:
    // a closed expense still posts, but a backfill or a rejected one never does.
    db.expenseLineItem.findMany({
      where: {
        manualQbAccount: { not: null },
        expense: { orgId, backfill: false, state: { not: "rejected" }, qbMatchState: { notIn: [...IN_QUICKBOOKS] } },
        OR: [{ expense: { qbMatchState: { in: [...WAITING_ON_FINANCE] } } }, { holds: { some: { status: "PENDING" } } }],
      },
      select: { expenseId: true, lineNumber: true, isCapital: true, manualQbAccount: true },
      orderBy: [{ expenseId: "asc" }, { lineNumber: "asc" }],
    }),
  ]);
  const refusal = (id: string, allowed: readonly string[], what: string) => accountTypeRefusal(accounts, id, allowed, what);
  return [
    ...listed.map((a) => withPlace(`Expense accounts, ${a.name}`, refusal(a.qbAccount, LISTED_TYPES, "An expense account"))),
    ...rules.map((r) =>
      withPlace(
        `Expense account rules, ${[r.category, r.subcategory, r.partNumber].filter(Boolean).join(" / ")}`,
        refusal(r.qbAccount, bookableTypes(r.isCapital), r.isCapital ? "A capital rule's account" : "A rule's account"),
      ),
    ),
    ...held.flatMap((l) =>
      l.manualQbAccount
        ? [withPlace(`Expense ${l.expenseId}, held line ${l.lineNumber}`, refusal(l.manualQbAccount, bookableTypes(l.isCapital), l.isCapital ? "A capital line's account" : "A line's account"))]
        : [],
    ),
  ].filter((line): line is string => line !== null);
}
