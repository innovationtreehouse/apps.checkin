"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Button, Group, Pagination, Text } from "@mantine/core";

/** The signed-in person as package UIs see them. The host maps its session onto this once. */
export interface Viewer {
  id: number;
  ageBand: "adult" | "youth" | "unknown";
  isFinance: boolean;
  isBoardMember: boolean;
  isOperations: boolean;
  isInventoryManager: boolean;
}

const ViewerContext = createContext<Viewer | null | undefined>(undefined);

export function ViewerProvider({ viewer, children }: { viewer: Viewer | null; children: ReactNode }) {
  return <ViewerContext.Provider value={viewer}>{children}</ViewerContext.Provider>;
}

/** The current viewer, or null when signed out. Routes gate server-side; this only decides which controls show. */
export function useViewer(): Viewer | null {
  const viewer = useContext(ViewerContext);
  if (viewer === undefined) throw new Error("useViewer must be used inside a ViewerProvider");
  return viewer;
}

/** Fetches `url` and returns its JSON body; a failure throws the route's `error` text, or the HTTP status. */
export async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const isForm = options.body instanceof FormData;
  const res = await fetch(url, { ...(isForm ? {} : { headers: { "Content-Type": "application/json" } }), ...options });
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

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  reload: () => void;
}

/** A package's fetch helpers over its routes under `base`. A path already under /api/ is used as given. */
export function createClient(base: string) {
  function api<T>(path: string, options: RequestInit = {}): Promise<T> {
    return request<T>(path.startsWith("/api/") ? path : `${base}${path}`, options);
  }

  /** Load `path` on mount and on reload(); null loads nothing. A stale response never overwrites a newer one. */
  function useLoad<T>(path: string | null, load: (path: string) => Promise<T> = api): Loaded<T> {
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [tick, setTick] = useState(0);
    const seq = useRef(0);
    // Held in a ref so a caller passing a new function each render doesn't refetch every render.
    const loadRef = useRef(load);
    useEffect(() => { loadRef.current = load; });
    useEffect(() => {
      if (path === null) return;
      const mine = ++seq.current;
      loadRef.current(path)
        .then((d) => { if (mine === seq.current) { setData(d); setError(null); } })
        .catch((e: unknown) => { if (mine === seq.current) setError(errorMessage(e)); });
    }, [path, tick]);
    const reload = useCallback(() => setTick((t) => t + 1), []);
    return { data, error, reload };
  }

  return { api, useLoad };
}

/** Tells the host nav to refetch its count pills after a write that changes them. */
export function notifyNavCounts(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("nav-counts-mutated"));
}

export const PAGE_SIZE = 50;

/** `path` asking for one page of a paged list route. */
export function paged(path: string, page: number): string {
  return `${path}${path.includes("?") ? "&" : "?"}page=${page}&limit=${PAGE_SIZE}`;
}

/** The last page number for `total` rows, never below 1. */
export function lastPage(total: number, pageSize = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Pages a list route that returns no total: a full page offers the next one. */
export function Pager({ page, onChange, rows }: { page: number; onChange: (page: number) => void; rows: readonly unknown[] | null | undefined }) {
  const total = page + ((rows?.length ?? 0) >= PAGE_SIZE ? 1 : 0);
  if (total <= 1) return null;
  return (
    <Group justify="center" mt="md">
      <Pagination value={page} onChange={onChange} total={total} />
    </Group>
  );
}

/** A failed load: names what failed and offers a retry, so it never reads as an empty list. */
export function LoadError({ what, message, onRetry }: { what: string; message: string; onRetry: () => void }) {
  return (
    <Alert color="red" title={`Couldn't load ${what}`} mb="md">
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm">{message}</Text>
        <Button size="xs" variant="light" color="red" onClick={onRetry}>Retry</Button>
      </Group>
    </Alert>
  );
}
