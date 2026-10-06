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
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
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
