"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";

/**
 * Client fetch helpers. Every income read and write goes through the host's routes under
 * /api/income/*; the routes gate server-side, so the client only uses the caller's role to
 * decorate the UI.
 */
const BASE = "/api/income";

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
 * Whether the current session may act (resolve, run, map, exclude). Mirrors the routes'
 * FINANCE gate; the flag rides on the host's augmented session user, which the library
 * does not type, so it is read through a narrow cast.
 */
export function useIsFinance(): boolean {
  const { data } = useSession();
  const user = data?.user as { isFinance?: boolean } | undefined;
  return user?.isFinance === true;
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

export function money(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}
