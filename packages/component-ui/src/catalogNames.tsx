"use client";
import { Alert } from "@mantine/core";
import { HttpError } from "./http";

/** Catalog name lookups by GTIN: the names found, the GTINs the catalog answered 404 for, and those whose lookup failed any other way. */
export interface CatalogNames {
  names: ReadonlyMap<string, string>;
  missing: ReadonlySet<string>;
  failed: ReadonlySet<string>;
}

export const NO_CATALOG_NAMES: CatalogNames = { names: new Map(), missing: new Set(), failed: new Set() };

/** Records one GTIN's lookup outcome: a name, or the error the catalog read threw. */
export function withLookup(prev: CatalogNames, gtin13: string, outcome: unknown): CatalogNames {
  const names = new Map(prev.names);
  const missing = new Set(prev.missing);
  const failed = new Set(prev.failed);
  names.delete(gtin13);
  missing.delete(gtin13);
  failed.delete(gtin13);
  if (typeof outcome === "string") names.set(gtin13, outcome);
  else if (outcome instanceof HttpError && outcome.status === 404) missing.add(gtin13);
  else failed.add(gtin13);
  return { names, missing, failed };
}

/** A provisional part's name, which the stock and receiving reads return beside their rows. */
export interface ProvisionalName { provisionalGtin13: string; name: string }

/** The text for each looked-up GTIN: the catalog's name, else the provisional part's, else why there is no name. */
export function withProvisionalNames(lookup: CatalogNames, provisionals: readonly ProvisionalName[] = []): ReadonlyMap<string, string> {
  return new Map([
    ...[...lookup.failed].map((g) => [g, "Name unavailable"] as const),
    ...[...lookup.missing].map((g) => [g, "Not in catalog"] as const),
    ...provisionals.map((p) => [p.provisionalGtin13, p.name] as const),
    ...lookup.names,
  ]);
}

/** The one banner a screen shows when any catalog name lookup failed for a reason other than 404. */
export function CatalogNamesUnavailable({ lookup }: { lookup: CatalogNames }) {
  if (lookup.failed.size === 0) return null;
  return (
    <Alert color="yellow" mb="md">
      Item names couldn&apos;t be loaded from the catalog. Showing Part IDs.
    </Alert>
  );
}
