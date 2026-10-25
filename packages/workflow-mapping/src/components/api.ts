"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";

/**
 * Client fetch helpers over the host's /api/workflow-mapping/* routes. The
 * routes gate server-side; the client reads the caller's role only to decide
 * which controls to show.
 */
export function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  return request<T>(`/api/workflow-mapping${path}`, options);
}

/** Reads from the catalog's own /api/catalog/* routes, the source of the legal category values. */
export function catalogApi<T>(path: string): Promise<T> {
  return request<T>(`/api/catalog${path}`);
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(res.ok ? `Unexpected non-JSON response (HTTP ${res.status})` : `HTTP ${res.status}`);
  }
  if (!res.ok) {
    const message = (data as { error?: unknown } | null)?.error;
    throw new Error(typeof message === "string" ? message : `HTTP ${res.status}`);
  }
  return data as T;
}

/** Tells the host nav to refetch its count pills after a write that can move a receipt's state. */
export function notifyNavCounts(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("nav-counts-mutated"));
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Error";
}

/** Mirrors the write routes' INVENTORY_MANAGER gate; read off the host's augmented session user. */
export function useCanManage(): boolean {
  const { data } = useSession();
  return (data?.user as { isInventoryManager?: boolean } | undefined)?.isInventoryManager === true;
}

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  reload: () => void;
}

/** Load `path` on mount and on reload(); a stale response never overwrites a newer one. */
export function useLoad<T>(path: string, load: (path: string) => Promise<T> = api): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  // Held in a ref so a caller passing a new function each render doesn't refetch every render.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; });
  useEffect(() => {
    const mine = ++seq.current;
    loadRef.current(path)
      .then((d) => { if (mine === seq.current) { setData(d); setError(null); } })
      .catch((e: unknown) => { if (mine === seq.current) setError(errorMessage(e)); });
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, reload };
}

export function formatCents(cents: number | null | undefined, currency = "USD"): string {
  return cents == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export { STATE_LABEL } from "../lib/stateLabels";
