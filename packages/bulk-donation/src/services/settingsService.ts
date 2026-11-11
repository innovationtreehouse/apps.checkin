// The in-kind lane's QuickBooks settings. FINANCE may lower the per-run create limit; raising it takes the board.
// Finance or the board may move the match window either way. Every change is recorded with its before and after.
import { ServiceError } from "@checkin/component-kit";
import { MATCH_WINDOW_DAYS, MAX_CREATES_PER_RUN, MAX_MATCH_WINDOW_DAYS } from "@checkin/quickbooks";
import { db, type DbOrTx } from "../db";
import { recordEvent } from "../repositories/audit";
import type { AuditContext } from "../workflows/disbursement.actor";

export interface DonationSettings {
  qbMatchWindowDays: number;
  qbMaxCreatesPerRun: number;
}

/** The column defaults; a missing row reads as these. */
export const DEFAULT_DONATION_SETTINGS: DonationSettings = {
  qbMatchWindowDays: MATCH_WINDOW_DAYS,
  qbMaxCreatesPerRun: MAX_CREATES_PER_RUN,
};

export interface DonationSettingsRoles {
  isFinance: boolean;
  isBoard: boolean;
}

/** A sanity ceiling on the create limit, for everyone. */
export const MAX_QB_CREATES = 1_000;
const SELECT = { qbMatchWindowDays: true, qbMaxCreatesPerRun: true } as const;

export async function readDonationSettings(client: DbOrTx, orgId: string): Promise<DonationSettings> {
  return (await client.donationOrgSettings.findUnique({ where: { orgId }, select: SELECT })) ?? DEFAULT_DONATION_SETTINGS;
}

/** The validated changes in `patch` against `current`; throws a 400 or 403 the route returns as is. */
export function settingsChanges(current: DonationSettings, patch: unknown, roles: DonationSettingsRoles): Partial<DonationSettings> {
  if (!roles.isFinance && !roles.isBoard) throw new ServiceError(403, "Only finance or the board can change donation settings");
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new ServiceError(400, "Settings must be an object");
  const changes: Partial<DonationSettings> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_DONATION_SETTINGS)) throw new ServiceError(400, `Unknown setting "${key}"`);
    const k = key as keyof DonationSettings;
    const max = k === "qbMatchWindowDays" ? MAX_MATCH_WINDOW_DAYS : MAX_QB_CREATES;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
      throw new ServiceError(400, `${key} must be a whole number from 1 to ${max}`);
    }
    if (value === current[k]) continue;
    if (k === "qbMaxCreatesPerRun" && value > current[k] && !roles.isBoard) throw new ServiceError(403, `Raising ${key} takes the board`);
    changes[k] = value;
  }
  return changes;
}

export async function updateDonationSettings(orgId: string, patch: unknown, roles: DonationSettingsRoles, actor: AuditContext): Promise<DonationSettings> {
  return db.$transaction(async (tx) => {
    const current = await readDonationSettings(tx, orgId);
    const changes = settingsChanges(current, patch, roles);
    const keys = Object.keys(changes) as (keyof DonationSettings)[];
    if (keys.length === 0) return current;
    const next = await tx.donationOrgSettings.upsert({ where: { orgId }, create: { orgId, ...changes }, update: changes, select: SELECT });
    await recordEvent(tx, {
      orgId,
      entityType: "donation_org_settings",
      entityId: orgId,
      eventType: "SETTINGS_UPDATED",
      ...actor,
      payload: { before: Object.fromEntries(keys.map((k) => [k, current[k]])), after: changes },
    });
    return next;
  });
}
