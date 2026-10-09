"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { notifications } from "@mantine/notifications";

/**
 * Client fetch helpers. Every expense read and write goes through the host's routes under
 * /api/expense/*; the routes gate and filter server-side, so the client uses the caller's
 * roles only to decide which controls to show.
 */
const BASE = "/api/expense";

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { "Content-Type": "application/json" }, ...options });
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

/** Sends a write, toasts the outcome, and reports whether it succeeded. */
export async function send(path: string, method: string, body: unknown, success: string): Promise<boolean> {
  try {
    await api(path, { method, body: JSON.stringify(body) });
    notifications.show({ message: success, color: "green" });
    return true;
  } catch (err) {
    notifications.show({ message: errorMessage(err), color: "red" });
    return false;
  }
}

/** The caller's finance roles, read through a narrow cast of the host's session user. */
export function useRoles(): { isFinance: boolean; isBoard: boolean } {
  const { data } = useSession();
  const user = data?.user as { isFinance?: boolean; isBoardMember?: boolean } | undefined;
  return { isFinance: user?.isFinance === true, isBoard: user?.isBoardMember === true };
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

export interface Bucket {
  id: number;
  name: string;
  archivedAt: string | null;
}

/** Bucket picker options from the registered local-owners route (FINANCE and Board). */
export function useBuckets(enabled: boolean): { value: string; label: string }[] {
  const { data } = useLoad<Bucket[]>(enabled ? "/local-owners" : null);
  return (data ?? []).filter((b) => !b.archivedAt).map((b) => ({ value: String(b.id), label: b.name }));
}
