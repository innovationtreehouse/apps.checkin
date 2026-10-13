import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { ZodType } from "zod";
import {
  CompletedReceiptSchema,
  ResolvedInventoryDeltaSchema,
  orgEventPayloadSchema,
  catalogItemsLookupSchema,
  catalogItemReferenceProposalSchema,
  catalogReferenceConflictSchema,
} from "@inventory/receipt-types";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export type Seam =
  | "S1-completed-receipt"
  | "S2-expense-receipt"
  | "S3-inventory-delta"
  | "S4-catalog-submissions"
  | "S5-org-events";

/**
 * The schema each fixture is validated against. S1/S2 share CompletedReceipt;
 * S4 varies by filename (lookup / proposal / conflict). Both the producer test
 * (emit must deep-equal the fixture) and the consumer test (feed the fixture)
 * resolve through this single map, so neither side can drift from the contract.
 */
function schemaFor(seam: Seam, file: string): ZodType {
  switch (seam) {
    case "S1-completed-receipt":
    case "S2-expense-receipt":
      return CompletedReceiptSchema;
    case "S3-inventory-delta":
      return ResolvedInventoryDeltaSchema;
    case "S5-org-events":
      return orgEventPayloadSchema;
    case "S4-catalog-submissions":
      if (file.startsWith("items-lookup")) return catalogItemsLookupSchema;
      if (file.startsWith("item-reference-proposal")) return catalogItemReferenceProposalSchema;
      if (file.startsWith("reference-conflict")) return catalogReferenceConflictSchema;
      throw new Error(`No S4 schema mapped for fixture: ${file}`);
  }
}

export interface FixtureEntry {
  /** e.g. "S1-completed-receipt/single-item-recognized" */
  id: string;
  seam: Seam;
  file: string;
  path: string;
  schema: ZodType;
}

const SEAMS: Seam[] = [
  "S1-completed-receipt",
  "S2-expense-receipt",
  "S3-inventory-delta",
  "S4-catalog-submissions",
  "S5-org-events",
];

export const FIXTURE_MANIFEST: FixtureEntry[] = SEAMS.flatMap((seam) => {
  const dir = join(FIXTURES_DIR, seam);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({
      id: `${seam}/${basename(file, ".json")}`,
      seam,
      file,
      path: join(dir, file),
      schema: schemaFor(seam, file),
    }));
});

/** Read + JSON.parse a fixture without validation (use in guard tests). */
export function loadRaw(entry: FixtureEntry): unknown {
  return JSON.parse(readFileSync(entry.path, "utf8"));
}

/** Read + validate a fixture against its contract schema; returns the typed value. */
export function loadValidated<T = unknown>(entry: FixtureEntry): T {
  return entry.schema.parse(loadRaw(entry)) as T;
}

function find(id: string): FixtureEntry {
  const entry = FIXTURE_MANIFEST.find((e) => e.id === id || e.id.endsWith(`/${id}`));
  if (!entry) throw new Error(`Unknown fixture: ${id}`);
  return entry;
}

/** Load a fixture by short name or full id, validated against its schema. */
export function fixture<T = unknown>(id: string): T {
  return loadValidated<T>(find(id));
}

/** All fixtures for one seam (sorted), validated. */
export function fixturesForSeam<T = unknown>(seam: Seam): Array<{ id: string; value: T }> {
  return FIXTURE_MANIFEST.filter((e) => e.seam === seam).map((e) => ({ id: e.id, value: loadValidated<T>(e) }));
}
