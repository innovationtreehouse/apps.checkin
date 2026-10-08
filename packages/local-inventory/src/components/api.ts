"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";

/**
 * Client fetch helpers. Every inventory read and write goes through the host's
 * human surface under /api/inventory/*; the routes gate server-side, so the
 * client only uses the caller's role to decorate the UI.
 */
const BASE = "/api/inventory";

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path.startsWith("/api/") ? path : `${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // A proxy error page or a sign-in redirect is HTML, not the route's JSON.
    throw new Error(res.ok ? `Unexpected non-JSON response (HTTP ${res.status})` : `HTTP ${res.status}`);
  }
  if (!res.ok) {
    const message = (data as { error?: unknown } | null)?.error;
    throw new Error(typeof message === "string" ? message : `HTTP ${res.status}`);
  }
  return data as T;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Error";
}

/**
 * Whether the current session may write inventory. Mirrors the routes'
 * INVENTORY_MANAGER gate; the flag rides on the host's augmented session user,
 * which the library does not type, so it is read through a narrow cast.
 */
export function useCanManage(): boolean {
  const { data } = useSession();
  const user = data?.user as { isInventoryManager?: boolean } | undefined;
  return user?.isInventoryManager === true;
}

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  reload: () => void;
}

/** Load `path` on mount and on reload(); a stale response never overwrites a newer one. */
export function useLoad<T>(path: string | null): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    if (!path) return;
    const mine = ++seq.current;
    api<T>(path)
      .then((d) => { if (mine === seq.current) { setData(d); setError(null); } })
      .catch((e: unknown) => { if (mine === seq.current) setError(errorMessage(e)); });
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, reload };
}

export const PAGE_SIZE = 50;

/** The last page number for `total` rows, never below 1. */
export function lastPage(total: number, pageSize = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
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
