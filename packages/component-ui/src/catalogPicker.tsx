"use client";
import { useEffect, useState } from "react";
import { Loader, Select } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { formatGtinDisplay, isProvisionalGtin13, parseGtinInput } from "@checkin/gtin";
import { errorMessage, request } from "./http";

/** GET /api/catalog/items rows, with their category and subcategory included. */
export interface CatalogItem {
  gtin13: string;
  name: string;
  category: { name: string };
  subcategory: { name: string };
}

export const MIN_CATALOG_SEARCH_LENGTH = 2;

/** The text to send to the catalog search, or null while it is too short to search. */
export function catalogSearchTerm(q: string): string | null {
  const term = q.trim();
  return term.length < MIN_CATALOG_SEARCH_LENGTH ? null : term;
}

export const catalogItemLabel = (item: CatalogItem) =>
  `${item.name} · ${item.category.name} / ${item.subcategory.name} · ${formatGtinDisplay(item.gtin13)}`;

export const CATALOG_SEARCH_DEBOUNCE_MS = 250;

/**
 * Catalog items matching the typed text, from the catalog's own search route. Results are only
 * ever for the current text: an older search that answers late is dropped, and `searching` holds
 * until the current text's search answers.
 */
export function useCatalogSearch(q: string): { items: CatalogItem[]; error: string | null; answered: boolean; searching: boolean } {
  const [result, setResult] = useState<{ term: string; items: CatalogItem[]; error: string | null } | null>(null);
  const [debounced] = useDebouncedValue(q, CATALOG_SEARCH_DEBOUNCE_MS);
  const sent = catalogSearchTerm(debounced);
  useEffect(() => {
    if (sent === null) return;
    let live = true;
    request<CatalogItem[]>(`/api/catalog/items?q=${encodeURIComponent(sent)}&limit=20`)
      .then((rows) => { if (live) setResult({ term: sent, items: rows, error: null }); })
      .catch((e: unknown) => { if (live) setResult({ term: sent, items: [], error: errorMessage(e) }); });
    return () => { live = false; };
  }, [sent]);
  const term = catalogSearchTerm(q);
  if (result && result.term === term) return { items: result.items, error: result.error, answered: true, searching: false };
  return { items: [], error: null, answered: false, searching: term !== null };
}

interface Option { value: string; label: string }

/**
 * One part, picked by its GTIN-13: a catalog item found by name, category or the ID shown on
 * screen, or a provisional part typed by its `P` number. The server checks the part exists.
 */
export function CatalogPicker({ label, value, onChange, w, placeholder = "Search by name, Part ID or part #" }: {
  label: string;
  value: string | null;
  onChange: (gtin13: string | null) => void;
  w?: number;
  placeholder?: string;
}) {
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<Option | null>(null);
  const found = useCatalogSearch(search);
  const typed = parseGtinInput(search);
  const options: Option[] = found.items.map((item) => ({ value: item.gtin13, label: catalogItemLabel(item) }));
  if (typed && isProvisionalGtin13(typed)) options.push({ value: typed, label: `${formatGtinDisplay(typed)} (provisional part)` });
  if (chosen && chosen.value === value && !options.some((o) => o.value === value)) options.unshift(chosen);

  return (
    <Select
      label={label}
      placeholder={placeholder}
      searchable
      clearable
      data={options}
      value={value}
      onChange={(v) => { setChosen(options.find((o) => o.value === v) ?? null); onChange(v); }}
      searchValue={search}
      onSearchChange={setSearch}
      // The catalog has already matched the text; a typed GTIN would not appear in the labels' short IDs.
      filter={({ options: all }) => all}
      nothingFoundMessage={found.searching ? "Searching…" : found.answered ? "No matching part" : `Type at least ${MIN_CATALOG_SEARCH_LENGTH} characters`}
      rightSection={found.searching ? <Loader size="xs" aria-label="Searching the catalog" /> : undefined}
      error={found.error && `Couldn't search the catalog: ${found.error}`}
      w={w}
    />
  );
}
