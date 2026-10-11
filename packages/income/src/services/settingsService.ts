// The org's caps on what one outbox drain may create. FINANCE may lower a cap; raising one
// takes the board. Every change is written to the audit log with its before and after.
import { db } from "../db";
import { recordAudit, type TxClient } from "../lib/audit";
import { ServiceError } from "./serviceError";
import type { Actor } from "./reconciliationService";

export interface IncomeSettings {
  maxCreatesPerRun: number;
  maxCreateCentsPerRun: number;
}

/** The column defaults; a missing row reads as these. */
export const DEFAULT_INCOME_SETTINGS: IncomeSettings = {
  maxCreatesPerRun: 25,
  maxCreateCentsPerRun: 2_500_000,
};

export interface SettingsActor extends Actor {
  isFinance: boolean;
  isBoard: boolean;
}

const KEYS = Object.keys(DEFAULT_INCOME_SETTINGS) as (keyof IncomeSettings)[];
const MAX_INT = 2_147_483_647;

export async function readIncomeSettings(client: TxClient | typeof db, orgId: string): Promise<IncomeSettings> {
  return (
    (await client.incomeOrgSettings.findUnique({
      where: { orgId },
      select: { maxCreatesPerRun: true, maxCreateCentsPerRun: true },
    })) ?? DEFAULT_INCOME_SETTINGS
  );
}

/** The validated changes in `patch` against `current`; throws a 400 or 403 the route returns as is. */
export function settingsChanges(current: IncomeSettings, patch: unknown, actor: SettingsActor): Partial<IncomeSettings> {
  if (!actor.isFinance && !actor.isBoard) throw new ServiceError(403, "Only finance or the board can change income settings");
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new ServiceError(400, "Settings must be an object");
  const changes: Partial<IncomeSettings> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!KEYS.includes(key as keyof IncomeSettings)) throw new ServiceError(400, `Unknown setting "${key}"`);
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_INT) {
      throw new ServiceError(400, `${key} must be a positive whole number`);
    }
    const k = key as keyof IncomeSettings;
    if (value === current[k]) continue;
    if (value > current[k] && !actor.isBoard) throw new ServiceError(403, `Raising ${key} takes the board`);
    changes[k] = value;
  }
  return changes;
}

export async function getIncomeSettings(orgId: string): Promise<IncomeSettings> {
  return readIncomeSettings(db, orgId);
}

export async function updateIncomeSettings(orgId: string, patch: unknown, actor: SettingsActor): Promise<IncomeSettings> {
  return db.$transaction(async (tx) => {
    const current = await readIncomeSettings(tx, orgId);
    const changes = settingsChanges(current, patch, actor);
    const keys = Object.keys(changes) as (keyof IncomeSettings)[];
    if (keys.length === 0) return current;
    const next = await tx.incomeOrgSettings.upsert({
      where: { orgId },
      create: { orgId, ...changes },
      update: changes,
      select: { maxCreatesPerRun: true, maxCreateCentsPerRun: true },
    });
    await recordAudit(tx, {
      orgId,
      actorUserId: actor.userId,
      actorUsername: actor.username,
      action: "settings.updated",
      entityType: "org_settings",
      entityId: orgId,
      before: Object.fromEntries(keys.map((k) => [k, current[k]])),
      after: changes,
      correlationId: actor.correlationId,
    });
    return next;
  });
}
