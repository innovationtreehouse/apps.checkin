"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";

/**
 * Client fetch helpers over the host's /api/workflow-mapping/* routes. The
 * routes gate server-side; the client reads the caller's role only to decide
 * which controls to show.
 */
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/workflow-mapping${path}`, { headers: { "Content-Type": "application/json" }, ...options });
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
export function useLoad<T>(path: string): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    api<T>(path)
      .then((d) => { if (mine === seq.current) { setData(d); setError(null); } })
      .catch((e: unknown) => { if (mine === seq.current) setError(errorMessage(e)); });
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, reload };
}

export function formatCents(cents: number | null | undefined, currency = "USD"): string {
  return cents == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export const STATE_LABEL: Record<string, string> = {
  pending_review: "Needs mapping",
  applying: "Applying",
  apply_failed: "Apply failed",
  resolved: "Resolved",
};
