"use client";
import { useEffect, useState } from "react";
import { createClient, useViewer } from "@checkin/component-ui";

/**
 * Client fetch helpers. Every inventory read and write goes through the host's
 * human surface under /api/inventory/*; the routes gate server-side, so the
 * client only uses the caller's role to decorate the UI.
 */
const BASE = "/api/inventory";

export const { api, useLoad } = createClient(BASE);

export { errorMessage, lastPage, notifyNavCounts, PAGE_SIZE, type Loaded } from "@checkin/component-ui";

/** Whether the viewer may write inventory. Mirrors the routes' INVENTORY_MANAGER gate. */
export function useCanManage(): boolean {
  return useViewer()?.isInventoryManager === true;
}

/** INVENTORY_MANAGER, FINANCE or BOARD: the receiving read gate, which also covers the inventory log (#2384). */
export function useCanSeeReceiving(): boolean {
  const viewer = useViewer();
  return viewer?.isInventoryManager === true || viewer?.isFinance === true || viewer?.isBoardMember === true;
}

/**
 * Catalog item names for the given GTINs, read from the host's catalog route
 * one item at a time (callers pass only the visible page). A GTIN the catalog
 * does not know — e.g. a provisional — simply has no name.
 */
export function useCatalogNames(gtins: readonly string[]): ReadonlyMap<string, string> {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const key = [...new Set(gtins)].sort().join(",");
  useEffect(() => {
    if (!key) return;
    let live = true;
    Promise.all(
      key.split(",").map((g) =>
        api<{ gtin13: string; name: string }>(`/api/catalog/items/${g}`).then(
          (item) => [g, item.name] as const,
          () => null,
        ),
      ),
    ).then((pairs) => {
      if (!live) return;
      setNames((prev) => {
        const next = new Map(prev);
        for (const p of pairs) if (p) next.set(p[0], p[1]);
        return next;
      });
    });
    return () => { live = false; };
  }, [key]);
  return names;
}
