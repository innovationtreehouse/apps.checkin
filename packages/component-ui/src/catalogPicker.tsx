"use client";
import { useEffect, useState } from "react";
import { Select } from "@mantine/core";
import { formatGtinDisplay, isProvisionalGtin13, parseGtinInput } from "@checkin/gtin";
import { errorMessage, request } from "./index";

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

/** Catalog items matching the typed text, from the catalog's own search route; none until a search for the current text returns. */
export function useCatalogSearch(q: string): { items: CatalogItem[]; error: string | null; answered: boolean } {
  const [result, setResult] = useState<{ term: string; items: CatalogItem[]; error: string | null } | null>(null);
  const term = catalogSearchTerm(q);
  useEffect(() => {
    if (term === null) return;
    let live = true;
    const t = setTimeout(() => {
      request<CatalogItem[]>(`/api/catalog/items?q=${encodeURIComponent(term)}&limit=20`)
        .then((rows) => { if (live) setResult({ term, items: rows, error: null }); })
        .catch((e: unknown) => { if (live) setResult({ term, items: [], error: errorMessage(e) }); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [term]);
  return result && result.term === term ? { items: result.items, error: result.error, answered: true } : { items: [], error: null, answered: false };
}

interface Option { value: string; label: string }

/**
 * One part, picked by its GTIN-13: a catalog item found by name, category or the ID shown on
 * screen, or a provisional part typed by its `P` number. The server checks the part exists.
 */
export function CatalogPicker({ label, value, onChange, w, placeholder = "Search by name or part no." }: {
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
      nothingFoundMessage={catalogSearchTerm(search) === null ? `Type at least ${MIN_CATALOG_SEARCH_LENGTH} characters` : found.answered ? "No matching part" : "Searching…"}
      error={found.error && `Couldn't search the catalog: ${found.error}`}
      w={w}
    />
  );
}
