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

/** A sanity ceiling on every threshold ($1,000,000), for everyone. */
export const MAX_THRESHOLD_CENTS = 100_000_000;
const cents = z.number().int().max(MAX_THRESHOLD_CENTS);

export const ExpenseSettingsPatchSchema = z.object({
  capitalTotalThresholdCents: cents.nonnegative(),
  capitalLineItemThresholdCents: cents.nonnegative(),
  capitalEquipmentUnitCents: cents.positive(),
  boardReviewTotalCents: cents.positive(),
  noteInLieuLimitCents: cents.positive(),
}).partial().strict();

/**
 * Which change to each threshold loosens a control. "up": a higher value. "up-or-off": a higher
 * non-zero value, or switching it off (non-zero → 0); switching it on (0 → non-zero) tightens.
 * FINANCE may tighten freely, and loosen only up to the policy value; past that, or for a
 * threshold with no policy value, loosening is the Board's. Every field must be listed here.
 */
export const THRESHOLD_RULES: Record<keyof ExpenseSettings, { loosens: "up" | "up-or-off"; policyCents?: number }> = {
  capitalEquipmentUnitCents: { loosens: "up", policyCents: 50_000 },
  boardReviewTotalCents: { loosens: "up", policyCents: 200_000 },
  noteInLieuLimitCents: { loosens: "up", policyCents: 5_000 },
  capitalTotalThresholdCents: { loosens: "up-or-off" },
  capitalLineItemThresholdCents: { loosens: "up-or-off" },
};

function loosens(field: keyof ExpenseSettings, from: number, to: number): boolean {
  if (THRESHOLD_RULES[field].loosens === "up-or-off" && (from === 0 || to === 0)) return from !== 0 && to === 0;
  return to > from;
}

/** Fields in the change that only the Board may make. */
export function boardOnlyChanges(current: ExpenseSettings, changes: Partial<ExpenseSettings>): (keyof ExpenseSettings)[] {
  return (Object.keys(changes) as (keyof ExpenseSettings)[]).filter((field) => {
    const to = changes[field]!;
    if (!loosens(field, current[field], to)) return false;
    const { policyCents } = THRESHOLD_RULES[field];
    return policyCents === undefined || to > policyCents;
  });
}

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
      throw new ServiceError(403, `Only the Board can loosen ${boardOnly.join(", ")} past the policy value or switch it off`);
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
