// The org's money thresholds. FINANCE or the board edits them; every change is recorded.
import { z } from "zod";
import { db } from "../db";
import type { Db } from "../db";
import type { ExpensePrincipal, ExpenseSettings } from "../contract";
import { assertOrg } from "../runtime";
import { actorOf } from "../lib/caller";
import { ServiceError } from "./serviceError";

/** The column defaults; a missing row reads as these. */
export const DEFAULT_EXPENSE_SETTINGS: ExpenseSettings = {
  capitalTotalThresholdCents: 0,
  capitalLineItemThresholdCents: 0,
  capitalEquipmentUnitCents: 50_000,
  boardReviewTotalCents: 200_000,
  noteInLieuLimitCents: 5_000,
};

export const ExpenseSettingsPatchSchema = z.object({
  capitalTotalThresholdCents: z.number().int().nonnegative(),
  capitalLineItemThresholdCents: z.number().int().nonnegative(),
  capitalEquipmentUnitCents: z.number().int().positive(),
  boardReviewTotalCents: z.number().int().positive(),
  noteInLieuLimitCents: z.number().int().positive(),
}).partial().strict();

const SELECT = {
  capitalTotalThresholdCents: true,
  capitalLineItemThresholdCents: true,
  capitalEquipmentUnitCents: true,
  boardReviewTotalCents: true,
  noteInLieuLimitCents: true,
} as const;

/** Reads without an org assertion, for in-library callers that already hold a row's orgId. */
export async function readExpenseSettings(client: Db, orgId: string): Promise<ExpenseSettings> {
  return (await client.expenseOrgSettings.findUnique({ where: { orgId }, select: SELECT })) ?? DEFAULT_EXPENSE_SETTINGS;
}

export async function getExpenseSettings(orgId: string): Promise<ExpenseSettings> {
  assertOrg(orgId);
  return readExpenseSettings(db, orgId);
}

export async function updateExpenseSettings(
  orgId: string,
  patch: unknown,
  principal: ExpensePrincipal,
): Promise<ExpenseSettings> {
  assertOrg(orgId);
  const actor = actorOf(principal);
  if (!principal.isFinance && !principal.isBoard) throw new ServiceError(403, "Only finance or the board can change expense settings");
  const changes = ExpenseSettingsPatchSchema.parse(patch);

  return db.$transaction(async (tx) => {
    const current = await readExpenseSettings(tx, orgId);
    const keys = (Object.keys(changes) as (keyof ExpenseSettings)[]).filter((k) => changes[k] !== current[k]);
    if (keys.length === 0) return current;
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
