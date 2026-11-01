// The org's money thresholds and QuickBooks posting limits. FINANCE or the board edits them; every
// change is recorded. The Everyday limits are the Board's alone.
import { z } from "zod";
import { db } from "../db";
import type { Db } from "../db";
import type { ExpensePrincipal, ExpenseSettings } from "../contract";
import { assertOrg } from "../runtime";
import { actorOf } from "../lib/caller";
import { ServiceError } from "@checkin/component-kit";
import { MATCH_WINDOW_DAYS, MAX_CREATES_PER_DAY, MAX_CREATES_PER_RUN, MAX_MATCH_WINDOW_DAYS } from "@checkin/quickbooks";
import { boardOnlyChanges } from "../lib/threshold-rules";

export { THRESHOLD_RULES, boardOnlyChanges } from "../lib/threshold-rules";

/** The column defaults; a missing row reads as these. */
export const DEFAULT_EXPENSE_SETTINGS: ExpenseSettings = {
  capitalTotalThresholdCents: 0,
  capitalLineItemThresholdCents: 0,
  boardReviewTotalCents: 200_000,
  everydayTotalLimitCents: 50_000,
  everydayItemLimitCents: 25_000,
  qbMatchWindowDays: MATCH_WINDOW_DAYS,
  qbMaxCreatesPerRun: MAX_CREATES_PER_RUN,
  qbMaxCreatesPerDay: MAX_CREATES_PER_DAY,
};

/** A sanity ceiling on every threshold ($1,000,000), for everyone. */
export const MAX_THRESHOLD_CENTS = 100_000_000;
const cents = z.number().int().max(MAX_THRESHOLD_CENTS);
/** A sanity ceiling on the QuickBooks create limits, for everyone. */
export const MAX_QB_CREATES = 1_000;
const qbCreates = z.number().int().min(1).max(MAX_QB_CREATES);

export const ExpenseSettingsPatchSchema = z.object({
  capitalTotalThresholdCents: cents.nonnegative(),
  capitalLineItemThresholdCents: cents.nonnegative(),
  boardReviewTotalCents: cents.positive(),
  everydayTotalLimitCents: cents.positive(),
  everydayItemLimitCents: cents.positive(),
  qbMatchWindowDays: z.number().int().min(1).max(MAX_MATCH_WINDOW_DAYS),
  qbMaxCreatesPerRun: qbCreates,
  qbMaxCreatesPerDay: qbCreates,
}).partial().strict();

const SELECT = {
  capitalTotalThresholdCents: true,
  capitalLineItemThresholdCents: true,
  boardReviewTotalCents: true,
  everydayTotalLimitCents: true,
  everydayItemLimitCents: true,
  qbMatchWindowDays: true,
  qbMaxCreatesPerRun: true,
  qbMaxCreatesPerDay: true,
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
    const merged = { ...current, ...changes };
    if (merged.qbMaxCreatesPerRun > merged.qbMaxCreatesPerDay) {
      throw new ServiceError(400, "The QuickBooks limit per run cannot be above the limit per day");
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
