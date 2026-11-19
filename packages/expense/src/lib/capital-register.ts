// Capital asset register — this app is the system of record for ITFANN fixed-asset numbers
// (Innovation Treehouse Fixed Asset, e.g. "ITFA23"; 2-digit zero-pad, no space/dash). ONE ROW PER
// PHYSICAL ASSET. Assets are only ever added: `registerAssets` mints them, and historical numbers
// hand-typed in QuickBooks are loaded via the seed endpoint (seeded=true).
import type { CapitalAsset, PrismaClient, Prisma } from "../generated/prisma/client";
import type { Actor } from "./workflow-engine";
import { writeOrgAudit } from "./audit";
import { allocateCents } from "@checkin/money";
import { ServiceError } from "@checkin/component-kit";

type Db = PrismaClient | Prisma.TransactionClient;

const PREFIX = "ITFA";
const PAD = 2;

/** Canonical form: `ITFA` + zero-padded (min 2) sequence, no space/dash. e.g. 23 -> "ITFA23". */
export function formatItfa(seq: number): string {
  return PREFIX + String(seq).padStart(PAD, "0");
}

/** Parse the numeric sequence out of any ITFA token (tolerant of padding); null if not one. */
export function parseItfa(raw: string): number | null {
  const m = /^ITFA0*(\d+)$/i.exec(raw.trim());
  return m ? Number(m[1]) : null;
}

/**
 * Date after which the asset is fully depreciated and need not be tracked: acquisition + years.
 * Dates are stored as strings; returns YYYY-MM-DD, or null if either input is missing/unparseable.
 */
export function fullyDepreciatedDate(acquisitionDate: string | null | undefined, years: number | null | undefined): string | null {
  if (!acquisitionDate || !years) return null;
  const d = new Date(acquisitionDate);
  if (Number.isNaN(d.getTime())) return null;
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().slice(0, 10);
}

/** How many physical assets a line of this quantity is: at least one. */
export const unitsOf = (quantity: number) => Math.max(1, Math.round(quantity));

/** Each unit's share of the line's cost; the shares sum to the cost exactly, the first units taking the odd cents. */
export function unitCosts(costCents: number, units: number): number[] {
  return allocateCents(costCents, Array.from({ length: units }, () => 1));
}

/** Highest ITFA sequence on the register for an org, seeded numbers included; 0 when none. */
async function registerMax(db: Db, orgId: string): Promise<number> {
  const rows = await db.capitalAsset.findMany({ where: { orgId }, select: { assetNumber: true } });
  let max = 0;
  for (const r of rows) {
    const n = parseItfa(r.assetNumber);
    if (n !== null && n > max) max = n;
  }
  return max;
}

/**
 * Locks the org's high-water mark for the rest of the transaction and returns it, never below the
 * register's highest number, which is read under the lock. The lock serialises mints and seeds.
 */
async function lockHighestIssued(tx: Prisma.TransactionClient, orgId: string): Promise<number> {
  await tx.$executeRaw`INSERT INTO capital_asset_sequences (org_id, highest_issued) VALUES (${orgId}, 0) ON CONFLICT (org_id) DO NOTHING`;
  const [row] = await tx.$queryRaw<{ highest_issued: number }[]>`SELECT highest_issued FROM capital_asset_sequences WHERE org_id = ${orgId} FOR UPDATE`;
  return Math.max(row.highest_issued, await registerMax(tx, orgId));
}

/** Raises the org's high-water mark to a seeded number, creating the mark if needed; it holds the mark's lock until commit. */
export async function raiseHighestIssued(tx: Prisma.TransactionClient, orgId: string, seq: number): Promise<void> {
  await tx.$executeRaw`INSERT INTO capital_asset_sequences (org_id, highest_issued) VALUES (${orgId}, ${seq})
    ON CONFLICT (org_id) DO UPDATE SET highest_issued = GREATEST(capital_asset_sequences.highest_issued, ${seq})`;
}

/** The columns a seed row sets from QuickBooks history. */
export type SeedColumns = Pick<
  CapitalAsset,
  "parentAssetNumber" | "description" | "acquisitionDate" | "costCents" | "depreciationYears" | "sourceQbTxnId" | "sourceQbTxnEntity"
>;

const SEED_COLUMNS = Object.keys({
  parentAssetNumber: true, description: true, acquisitionDate: true, costCents: true, depreciationYears: true, sourceQbTxnId: true, sourceQbTxnEntity: true,
} satisfies Record<keyof SeedColumns, true>) as (keyof SeedColumns)[];

/**
 * Why a seed row cannot take a number an asset already holds, or null when the row repeats that
 * asset's own seed exactly. A number is a physical label, so a collision is never skipped silently.
 */
export function seedCollision(assetNumber: string, existing: SeedColumns & { seeded: boolean }, seed: SeedColumns): string | null {
  if (!existing.seeded) return `${assetNumber} was already issued by the app to a new asset; it cannot be seeded`;
  if (SEED_COLUMNS.every((c) => existing[c] === seed[c])) return null;
  return `${assetNumber} was already issued and seeded with different details; it cannot be seeded again`;
}

export type AssetSource =
  | { kind: "expense_line"; expenseId: string; lineItemId: number }
  | { kind: "gift_line"; giftSource: "receipt" | "manual"; giftId: number; giftLineId: number; donatedLineId?: number };

export interface AssetUnit {
  costCents: number;
  acquisitionDate: string | null;
  depreciationYears: number;
  description: string;
}

function sourceColumns(source: AssetSource) {
  return source.kind === "expense_line"
    ? { sourceKind: source.kind, sourceExpenseId: source.expenseId, sourceLineItemId: source.lineItemId, sourceReceiptId: source.expenseId }
    : { sourceKind: source.kind, sourceGiftSource: source.giftSource, sourceGiftId: source.giftId, sourceGiftLineId: source.giftLineId, sourceDonatedLineId: source.donatedLineId };
}

function sourceWhere(orgId: string, source: AssetSource): Prisma.CapitalAssetWhereInput {
  return source.kind === "expense_line"
    ? { orgId, sourceLineItemId: source.lineItemId, unitIndex: { not: null } }
    : { orgId, sourceGiftSource: source.giftSource, sourceGiftLineId: source.giftLineId, unitIndex: { not: null } };
}

/**
 * Mints one asset per unit for the line, each numbered from the org's high-water mark, and audits
 * each. A repeat for the same line mints nothing and returns the same numbers, in unit order.
 */
export async function registerAssets(
  tx: Prisma.TransactionClient,
  actor: Actor,
  orgId: string,
  source: AssetSource,
  units: AssetUnit[],
): Promise<string[]> {
  let highest = await lockHighestIssued(tx, orgId);
  const existing = await tx.capitalAsset.findMany({ where: sourceWhere(orgId, source), select: { unitIndex: true, assetNumber: true } });
  const numbers = new Map(existing.map((a) => [a.unitIndex!, a.assetNumber]));
  const columns = sourceColumns(source);
  for (const [unitIndex, unit] of units.entries()) {
    if (numbers.has(unitIndex)) continue;
    const assetNumber = formatItfa(++highest);
    await tx.capitalAsset.create({
      data: {
        orgId,
        assetNumber,
        description: unit.description,
        acquisitionDate: unit.acquisitionDate,
        costCents: unit.costCents,
        depreciationYears: unit.depreciationYears,
        fullyDepreciatedDate: fullyDepreciatedDate(unit.acquisitionDate, unit.depreciationYears),
        status: "tracked",
        ...columns,
        unitIndex,
        seeded: false,
      },
    });
    await writeOrgAudit(tx, orgId, actor, {
      entityType: "capital_asset",
      entityId: assetNumber,
      action: "capital_asset_registered",
      after: { source, unitIndex, costCents: unit.costCents },
    });
    numbers.set(unitIndex, assetNumber);
  }
  await tx.$executeRaw`UPDATE capital_asset_sequences SET highest_issued = ${highest} WHERE org_id = ${orgId}`;
  return units.map((_, unitIndex) => numbers.get(unitIndex)!);
}

/**
 * Links a backfilled line to its historical assets, one seeded number per unit in unit order, and
 * audits each. Mints nothing and leaves the high-water mark alone. A repeat for the same line and
 * units does nothing; a number that is not seeded, or is linked elsewhere, is refused.
 */
export async function linkAssets(
  tx: Prisma.TransactionClient,
  actor: Actor,
  orgId: string,
  source: Extract<AssetSource, { kind: "expense_line" }>,
  seededAssetNumbers: string[],
): Promise<void> {
  const numbers = seededAssetNumbers.map((raw) => {
    const seq = parseItfa(raw);
    if (seq === null) throw new ServiceError(400, `${raw} is not an ITFA number`);
    return formatItfa(seq);
  });
  if (new Set(numbers).size !== numbers.length) throw new ServiceError(400, "Each unit needs its own seeded asset number");
  const columns = sourceColumns(source);
  for (const [unitIndex, assetNumber] of numbers.entries()) {
    const asset = await tx.capitalAsset.findUnique({ where: { capital_assets_org_number_unique: { orgId, assetNumber } } });
    if (!asset || !asset.seeded) throw new ServiceError(400, `${assetNumber} is not a seeded asset; seed it first`);
    if (asset.sourceKind !== null) {
      if (asset.sourceLineItemId === source.lineItemId && asset.unitIndex === unitIndex) continue;
      throw new ServiceError(409, `${assetNumber} is already linked to another line`);
    }
    // Conditional, so of two backfills linking the same asset at once only one wins.
    const linked = await tx.capitalAsset.updateMany({ where: { id: asset.id, sourceKind: null }, data: { ...columns, unitIndex } });
    if (linked.count === 0) {
      const now = await tx.capitalAsset.findUniqueOrThrow({ where: { id: asset.id } });
      if (now.sourceLineItemId === source.lineItemId && now.unitIndex === unitIndex) continue;
      throw new ServiceError(409, `${assetNumber} is already linked to another line`);
    }
    await writeOrgAudit(tx, orgId, actor, {
      entityType: "capital_asset",
      entityId: assetNumber,
      action: "capital_asset_linked",
      after: { source, unitIndex },
    });
  }
}
