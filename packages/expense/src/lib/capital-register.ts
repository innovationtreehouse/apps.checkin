// Capital asset register — this app is the system of record for ITFANN fixed-asset numbers
// (Innovation Treehouse Fixed Asset, e.g. "ITFA23"; 2-digit zero-pad, no space/dash). ONE ROW PER
// PHYSICAL ASSET. Numbers are minted here (max+1) for new capital designations; historical numbers
// hand-typed in QuickBooks are loaded via the seed endpoint (seeded=true).
import type { PrismaClient, Prisma } from "../generated/prisma/client";

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

/**
 * Next ITFA sequence for an org = max existing + 1. Scans the register (low volume; a nonprofit's
 * fixed assets number in the dozens). The (orgId, assetNumber) unique index is the race backstop.
 * ponytail: full-scan max, fine at this scale; add a per-org counter row if asset volume ever explodes.
 */
export async function nextItfaSeq(db: Db, orgId: string): Promise<number> {
  const rows = await db.capitalAsset.findMany({ where: { orgId }, select: { assetNumber: true } });
  let max = 0;
  for (const r of rows) {
    const n = parseItfa(r.assetNumber);
    if (n !== null && n > max) max = n;
  }
  return max + 1;
}
