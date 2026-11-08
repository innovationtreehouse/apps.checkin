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
} from "@checkin/receipt-types";

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

/** A crossing between libraries that has a refusals fixture under `fixtures/refusals/`. */
export type Crossing = "S1" | "X13" | "X5" | "X9" | "X4" | "gift-load" | "capital-send";

export const CROSSINGS: Crossing[] = ["S1", "X13", "X5", "X9", "X4", "gift-load", "capital-send"];

/** What the callee must answer: a normal return, a refusal for good (`kindOf` "data"), or a wiring bug (`kindOf` "bug"). */
export type RefusalExpectation = "accepted" | "refused" | "bug";

interface PayloadEdit {
  /** Dotted paths into the payload, array indexes included (`lineItems.0.quantity`). */
  set?: Record<string, unknown>;
  unset?: string[];
}

interface RefusalsFile {
  crossing: Crossing;
  callee: string;
  base: ({ fixture: string } | { payload: Record<string, unknown> }) & PayloadEdit;
  cases: Array<PayloadEdit & { name: string; expect: RefusalExpectation; after?: "base" }>;
}

export interface RefusalCase<P> {
  name: string;
  expect: RefusalExpectation;
  /** The base payload is sent first, so the case is a resend. */
  afterBase: boolean;
  payload: P;
}

export interface Refusals<P> {
  crossing: Crossing;
  callee: string;
  base: P;
  cases: Array<RefusalCase<P>>;
}

const REFUSALS_DIR = join(FIXTURES_DIR, "refusals");

/** The raw refusals file for a crossing, edits unapplied (use in guard tests). */
export function loadRefusalsFile(crossing: Crossing): RefusalsFile {
  return JSON.parse(readFileSync(join(REFUSALS_DIR, `${crossing}.json`), "utf8")) as RefusalsFile;
}

/** Walks a dotted path to its parent container and last key; throws when a step is missing. */
function locate(root: unknown, path: string): { parent: Record<string, unknown>; key: string } {
  const keys = path.split(".");
  let node = root;
  for (const k of keys.slice(0, -1)) {
    if (typeof node !== "object" || node === null || !(k in node)) throw new Error(`No ${path} in the payload`);
    node = (node as Record<string, unknown>)[k];
  }
  if (typeof node !== "object" || node === null) throw new Error(`No ${path} in the payload`);
  return { parent: node as Record<string, unknown>, key: keys[keys.length - 1] };
}

/** True when every edited path names a field the payload already has, so a typo can't leave a case equal to its base. */
export function editTargetsExist(payload: unknown, edit: PayloadEdit): boolean {
  const paths = [...Object.keys(edit.set ?? {}), ...(edit.unset ?? [])];
  return paths.every((p) => {
    try {
      const { parent, key } = locate(payload, p);
      return key in parent;
    } catch {
      return false;
    }
  });
}

function applyEdit<T>(payload: T, edit: PayloadEdit): T {
  const copy = structuredClone(payload);
  for (const [path, value] of Object.entries(edit.set ?? {})) {
    const { parent, key } = locate(copy, path);
    parent[key] = value;
  }
  for (const path of edit.unset ?? []) {
    const { parent, key } = locate(copy, path);
    delete parent[key];
  }
  return copy;
}

/**
 * A crossing's refusals fixture with every payload built: the base (a seam fixture or an inline
 * payload) with its `orgId` set to the callee's org, then each case's edits. A callee test sends
 * each case and checks the answer against `expect`.
 */
export function refusals<P = Record<string, unknown>>(crossing: Crossing, opts: { orgId: string }): Refusals<P> {
  const file = loadRefusalsFile(crossing);
  const start = "fixture" in file.base ? loadRaw(find(file.base.fixture)) : file.base.payload;
  const base = applyEdit({ ...(start as Record<string, unknown>), orgId: opts.orgId }, file.base) as P;
  return {
    crossing: file.crossing,
    callee: file.callee,
    base,
    cases: file.cases.map((c) => ({ name: c.name, expect: c.expect, afterBase: c.after === "base", payload: applyEdit(base, c) })),
  };
}
