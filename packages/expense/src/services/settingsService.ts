// The org's money thresholds. FINANCE or the board edits them; every change is recorded.
// The Everyday limits are the Board's alone.
import { z } from "zod";
import { db } from "../db";
import type { Db } from "../db";
import type { ExpensePrincipal, ExpenseSettings } from "../contract";
import { assertOrg } from "../runtime";
import { actorOf } from "../lib/caller";
import { ServiceError } from "@checkin/component-kit";
import { boardOnlyChanges } from "../lib/threshold-rules";

export { THRESHOLD_RULES, boardOnlyChanges } from "../lib/threshold-rules";

/** The column defaults; a missing row reads as these. */
export const DEFAULT_EXPENSE_SETTINGS: ExpenseSettings = {
  capitalTotalThresholdCents: 0,
  capitalLineItemThresholdCents: 0,
  boardReviewTotalCents: 200_000,
  everydayTotalLimitCents: 50_000,
  everydayItemLimitCents: 25_000,
};

/** A sanity ceiling on every threshold ($1,000,000), for everyone. */
export const MAX_THRESHOLD_CENTS = 100_000_000;
const cents = z.number().int().max(MAX_THRESHOLD_CENTS);

export const ExpenseSettingsPatchSchema = z.object({
  capitalTotalThresholdCents: cents.nonnegative(),
  capitalLineItemThresholdCents: cents.nonnegative(),
  boardReviewTotalCents: cents.positive(),
  everydayTotalLimitCents: cents.positive(),
  everydayItemLimitCents: cents.positive(),
}).partial().strict();

const SELECT = {
  capitalTotalThresholdCents: true,
  capitalLineItemThresholdCents: true,
  boardReviewTotalCents: true,
  everydayTotalLimitCents: true,
  everydayItemLimitCents: true,
} as const;

/** Reads without an org assertion, for in-library callers that already hold a row's orgId. */
export async function readExpenseSettings(client: Db, orgId: string): Promise<ExpenseSettings> {
  return (await client.expenseOrgSettings.findUnique({ where: { orgId }, select: SELECT })) ?? DEFAULT_EXPENSE_SETTINGS;
}

export async function getExpenseSettings(orgId: string): Promise<ExpenseSettings> {
  await assertOrg(orgId);
  return readExpenseSettings(db, orgId);
}

export async function updateExpenseSettings(
  orgId: string,
  patch: unknown,
  principal: ExpensePrincipal,
): Promise<ExpenseSettings> {
  await assertOrg(orgId);
  const actor = actorOf(principal);
  if (!principal.isFinance && !principal.isBoard) throw new ServiceError(403, "Only finance or the board can change expense settings");
  const changes = ExpenseSettingsPatchSchema.parse(patch);

  return db.$transaction(async (tx) => {
    const current = await readExpenseSettings(tx, orgId);
    const keys = (Object.keys(changes) as (keyof ExpenseSettings)[]).filter((k) => changes[k] !== current[k]);
    if (keys.length === 0) return current;
    const boardOnly = boardOnlyChanges(current, changes);
    if (boardOnly.length > 0 && !principal.isBoard) {
      throw new ServiceError(403, `Only the Board can make this change to ${boardOnly.join(", ")}`);
    }
    const pick = (s: Partial<ExpenseSettings>) => Object.fromEntries(keys.map((k) => [k, s[k]]));
    const next = await tx.expenseOrgSettings.upsert({
      where: { orgId },
      create: { orgId, ...changes },
      update: changes,
      select: SELECT,
    });
    await tx.expenseOrgSettingsChange.create({
      data: {
        orgId,
        actorUserId: actor.userId,
        actorUsername: actor.username,
        before: JSON.stringify(pick(current)),
        after: JSON.stringify(pick(changes)),
      },
    });
    return next;
  });
}
