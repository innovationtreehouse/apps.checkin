"use client";
import { useEffect, useState } from "react";
import { createClient, NO_CATALOG_NAMES, useViewer, withLookup, type CatalogNames } from "@checkin/component-ui";

/**
 * Client fetch helpers. Every inventory read and write goes through the host's
 * human surface under /api/inventory/*; the routes gate server-side, so the
 * client only uses the caller's role to decorate the UI.
 */
const BASE = "/api/inventory";

export const { api, useLoad } = createClient(BASE);

export {
  CatalogNamesUnavailable, errorMessage, lastPage, notifyNavCounts, PAGE_SIZE, withProvisionalNames, type CatalogNames, type Loaded, type ProvisionalName,
} from "@checkin/component-ui";

/** Whether the viewer may write inventory. Mirrors the routes' INVENTORY_MANAGER gate. */
export function useCanManage(): boolean {
  return useViewer()?.isInventoryManager === true;
}

/** INVENTORY_MANAGER, FINANCE or BOARD: the receiving read gate, which also covers the inventory log. */
export function useCanSeeReceiving(): boolean {
  const viewer = useViewer();
  return viewer?.isInventoryManager === true || viewer?.isFinance === true || viewer?.isBoardMember === true;
}

/**
 * Catalog item names for the given GTINs, read from the host's catalog route
 * one item at a time (callers pass only the visible page). A provisional
 * part's GTIN is one the catalog answers 404 for. Found names stay cached
 * across pages; `failed` holds only the latest page's failures.
 */
export function useCatalogNames(gtins: readonly string[]): CatalogNames {
  const [lookup, setLookup] = useState<CatalogNames>(NO_CATALOG_NAMES);
  const key = [...new Set(gtins)].sort().join(",");
  useEffect(() => {
    if (!key) return;
    let live = true;
    const ids = key.split(",");
    Promise.all(
      ids.map((g) => api<{ gtin13: string; name: string }>(`/api/catalog/items/${g}`).then((item): unknown => item.name, (e: unknown) => e)),
    ).then((outcomes) => {
      if (live) setLookup((prev) => ids.reduce<CatalogNames>((acc, g, i) => withLookup(acc, g, outcomes[i]), { ...prev, failed: new Set() }));
    });
    return () => { live = false; };
  }, [key]);
  return lookup;
}
