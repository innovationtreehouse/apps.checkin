"use client";
import { useSession } from "next-auth/react";

/**
 * Shared client fetch helper (#1286 track 5). All catalog reads/writes go
 * through checkin's human surface under /api/catalog/*; the route handlers gate
 * server-side, so the client only decorates the UI with the caller's role.
 */
const BASE = "/api/catalog";

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
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

/** The message to show for a failed call. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Error";
}

/**
 * Drops stale responses: each `begin()` starts a request and returns a check
 * that stays true only while no later request has begun.
 */
export function latestGate(): () => () => boolean {
  let seq = 0;
  return () => {
    const mine = ++seq;
    return () => mine === seq;
  };
}

/** The last page number for `total` rows, never below 1. */
export function lastPage(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * Whether the current session may curate the catalog (write). Mirrors the
 * routes' INVENTORY_MANAGER gate; the flag rides on checkin's augmented session
 * user, which the library does not type, so it is read through a narrow cast.
 */
export function useCanManage(): boolean {
  const { data } = useSession();
  const user = data?.user as { isInventoryManager?: boolean } | undefined;
  return user?.isInventoryManager === true;
}
