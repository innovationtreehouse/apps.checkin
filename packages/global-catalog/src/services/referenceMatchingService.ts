import type { Prisma } from "../generated/prisma/client";
import { db } from "../db";
import { createItemReferenceRepository } from "../repositories/itemReference";
import { ServiceError } from "@checkin/component-kit";

const itemRefRepo = createItemReferenceRepository(db);
import { normalizeDescription } from "../lib/normalizeDescription";

export interface LookupEntry {
  index: number;
  partNumber?: string | null;
  manufacturer?: string | null;
  description?: string | null;
}

export interface LookupResult {
  index: number;
  gtin13: string | null;
  itemReferenceId: number | null;
  conversionFactor: number;
  conversionVersion: number;
}

export interface RefInfo {
  exists: boolean;
  gtin13: string | null;
  id: number | null;
  conversionFactor: number;
  conversionVersion: number;
}

export interface RefCheckResult {
  mfr_part: RefInfo;
  retailer_part: RefInfo;
  mfr_desc: RefInfo;
  wouldCreateNewReference: boolean;
}

export interface RefFields {
  partNumber: string | null;
  manufacturer: string | null;
  description: string | null;
  retailer: string | null;
}

type RefRow = { gtin13: string; id: number; conversionFactor: number; conversionVersion: number };

function toRefInfo(ref: RefRow | null): RefInfo {
  return ref
    ? { exists: true, gtin13: ref.gtin13, id: ref.id, conversionFactor: ref.conversionFactor, conversionVersion: ref.conversionVersion }
    : { exists: false, gtin13: null, id: null, conversionFactor: 1.0, conversionVersion: 1 };
}

export async function lookupMany(retailer: string, lookups: LookupEntry[]): Promise<LookupResult[]> {
  const results: LookupResult[] = [];

  for (const entry of lookups) {
    let ref: RefRow | null = null;

    if (entry.partNumber && entry.manufacturer) {
      ref = await itemRefRepo.findByMfrPart(entry.partNumber, entry.manufacturer);
    }

    if (!ref && entry.partNumber) {
      ref = await itemRefRepo.findByRetailerPart(retailer, entry.partNumber);
    }

    if (!ref && !entry.partNumber && entry.manufacturer && entry.description) {
      const normalized = normalizeDescription(entry.description);
      if (normalized) {
        ref = await itemRefRepo.findByMfrDesc(normalized, entry.manufacturer);
      }
    }

    results.push({
      index: entry.index,
      gtin13: ref?.gtin13 ?? null,
      itemReferenceId: ref?.id ?? null,
      conversionFactor: ref?.conversionFactor ?? 1.0,
      conversionVersion: ref?.conversionVersion ?? 1,
    });
  }

  return results;
}

/**
 * The canonical conversion factor/version for a catalog item (gtin13). A gtin13
 * can carry several active ItemReferences (one per retailer/part lookup key),
 * each with its own factor; there is no single intrinsic factor on the Item. For
 * cross-app emit (S5 provisional_mapped_to_existing) we need ONE deterministic
 * value, so we pick the most-current reference: highest conversionVersion, then
 * highest id (most recently created) as the tie-break. No active reference →
 * {1, 1} ("each", the default unit).
 */
export async function getCanonicalConversion(gtin13: string): Promise<{ conversionFactor: number; conversionVersion: number }> {
  const refs = await itemRefRepo.listByGtin13(gtin13);
  if (refs.length === 0) return { conversionFactor: 1, conversionVersion: 1 };
  const best = refs.reduce((a, b) => {
    if (b.conversionVersion !== a.conversionVersion) return b.conversionVersion > a.conversionVersion ? b : a;
    return b.id > a.id ? b : a;
  });
  return { conversionFactor: best.conversionFactor, conversionVersion: best.conversionVersion };
}

export async function checkReferences(params: {
  retailer?: string;
  partNumber?: string | null;
  manufacturer?: string | null;
  description?: string | null;
}): Promise<RefCheckResult> {
  const { retailer, partNumber, manufacturer, description: rawDescription } = params;
  const normalized = rawDescription ? normalizeDescription(rawDescription) : null;

  let mfrPartRef: RefRow | null = null;
  let retailerPartRef: RefRow | null = null;
  let mfrDescRef: RefRow | null = null;

  if (partNumber && manufacturer) {
    mfrPartRef = await itemRefRepo.findByMfrPart(partNumber, manufacturer);
  }

  if (partNumber && retailer) {
    retailerPartRef = await itemRefRepo.findByRetailerPart(retailer, partNumber);
  }

  if (!partNumber && manufacturer && normalized) {
    mfrDescRef = await itemRefRepo.findByMfrDesc(normalized, manufacturer);
  }

  let wouldCreateNewReference = false;
  if (partNumber && manufacturer && !mfrPartRef) wouldCreateNewReference = true;
  if (partNumber && !retailerPartRef) wouldCreateNewReference = true;
  if (!partNumber && manufacturer && normalized && !mfrDescRef) wouldCreateNewReference = true;

  return {
    mfr_part: toRefInfo(mfrPartRef),
    retailer_part: toRefInfo(retailerPartRef),
    mfr_desc: toRefInfo(mfrDescRef),
    wouldCreateNewReference,
  };
}

/** The lookup keys a reference answers to, the same ones lookups and the conflict check use. */
function referenceKeys(fields: RefFields): string[] {
  const { partNumber, manufacturer, retailer } = fields;
  const normalized = fields.description ? normalizeDescription(fields.description) : null;
  const keys: unknown[][] = [];
  if (manufacturer && partNumber) keys.push(["mfr-part", manufacturer, partNumber]);
  if (retailer && partNumber) keys.push(["retailer-part", retailer, partNumber]);
  if (!partNumber && manufacturer && normalized) keys.push(["mfr-desc", manufacturer, normalized]);
  return keys.map((k) => JSON.stringify(k));
}

/** Holds each of the reference's lookup keys until `tx` ends, in sorted order so writers can't deadlock. */
export async function lockReferenceKeys(tx: Prisma.TransactionClient, fields: RefFields): Promise<void> {
  for (const key of referenceKeys(fields).sort()) {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`item-reference:${key}`}, 0))`;
  }
}

async function findAutoConflict(
  tx: Prisma.TransactionClient,
  ownGtin13: string,
  fields: RefFields,
  excludeId?: number,
): Promise<string | null> {
  const refs = createItemReferenceRepository(tx);
  const conflictLabel = async (gtin13: string) => {
    const it = await tx.item.findFirst({ where: { gtin13 }, select: { name: true } });
    return it?.name ?? gtin13;
  };

  if (fields.manufacturer && fields.partNumber) {
    const hit = await refs.findConflictByMfrPart(fields.partNumber, fields.manufacturer, ownGtin13, excludeId);
    if (hit) return `Auto-reference conflict with "${await conflictLabel(hit.gtin13)}" (same manufacturer + part number)`;
  }

  if (fields.retailer && fields.partNumber) {
    const hit = await refs.findConflictByRetailerPart(fields.retailer, fields.partNumber, ownGtin13, excludeId);
    if (hit) return `Auto-reference conflict with "${await conflictLabel(hit.gtin13)}" (same retailer + part number)`;
  }

  if (!fields.partNumber && fields.manufacturer && fields.description) {
    const normalized = normalizeDescription(fields.description);
    if (normalized) {
      const hit = await refs.findConflictByMfrDesc(normalized, fields.manufacturer, ownGtin13, excludeId);
      if (hit) return `Auto-reference conflict with "${await conflictLabel(hit.gtin13)}" (same manufacturer + description)`;
    }
  }

  return null;
}

/**
 * Refuses a reference write that would point a lookup key at a second item. Every writer calls
 * this in the transaction that writes the reference; the key locks make check-then-write atomic.
 * `excludeId` is the reference being moved to `ownGtin13`, which must not conflict with itself.
 * ponytail: app-level locks, so a writer that skips this isn't stopped; a partial EXCLUDE constraint is the upgrade.
 */
export async function assertNoReferenceConflict(
  tx: Prisma.TransactionClient,
  ownGtin13: string,
  fields: RefFields,
  excludeId?: number,
): Promise<void> {
  await lockReferenceKeys(tx, fields);
  const conflict = await findAutoConflict(tx, ownGtin13, fields, excludeId);
  if (conflict) throw new ServiceError(409, conflict);
}
