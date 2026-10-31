"use client";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Alert, Button, Group, Pagination, Text } from "@mantine/core";
import useSWR from "swr";
import { clearLoads, countFailure, endRetryChain, forgetFailures, invalidateLoads, scheduleRetry } from "./loadCache";

export { invalidateLoads };

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

const SessionExpiredContext = createContext<(() => void) | undefined>(undefined);

/**
 * `onSessionExpired` runs when a load answers 401. A person's cached loads end with them:
 * null is also "session loading", so only a move away from a known person clears, and it
 * clears before paint so their rows never show to the next viewer.
 */
export function ViewerProvider({ viewer, onSessionExpired, children }: { viewer: Viewer | null; onSessionExpired?: () => void; children: ReactNode }) {
  const id = viewer?.id ?? null;
  const lastId = useRef(id);
  useLayoutEffect(() => {
    if (lastId.current !== null && lastId.current !== id) clearLoads();
    lastId.current = id;
  }, [id]);
  return (
    <SessionExpiredContext.Provider value={onSessionExpired}>
      <ViewerContext.Provider value={viewer}>{children}</ViewerContext.Provider>
    </SessionExpiredContext.Provider>
  );
}

/** The current viewer, or null when signed out. Routes gate server-side; this only decides which controls show. */
export function useViewer(): Viewer | null {
  const viewer = useContext(ViewerContext);
  if (viewer === undefined) throw new Error("useViewer must be used inside a ViewerProvider");
  return viewer;
}

/** A response that was not a usable answer. Its message is the route's `error` text, or names the HTTP status. */
export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "HttpError";
  }
}

/** `invalidate: false` is for a loop of writes, which calls `invalidateLoads` once when it ends. */
export type RequestOptions = RequestInit & { invalidate?: boolean };

/** Fetches `url` and returns its JSON body; a failure throws `HttpError`. A successful write re-reads every cached load. */
export async function request<T>(url: string, { invalidate = true, ...options }: RequestOptions = {}): Promise<T> {
  const isForm = options.body instanceof FormData;
  const res = await fetch(url, { ...(isForm ? {} : { headers: { "Content-Type": "application/json" } }), ...options });
  if (res.ok && invalidate && (options.method ?? "GET").toUpperCase() !== "GET") invalidateLoads();
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // A proxy error page or a sign-in redirect is HTML, not the route's JSON.
    throw new HttpError(res.ok ? `Unexpected non-JSON response (HTTP ${res.status})` : `HTTP ${res.status}`, res.status);
  }
  if (!res.ok) {
    const message = (data as { error?: unknown } | null)?.error;
    throw new HttpError(typeof message === "string" ? message : `HTTP ${res.status}`, res.status);
  }
  return data as T;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Error";
}

export interface Loaded<T> {
  data: T | null;
  /** Null while the first answer for this path is awaited or a retry is pending. */
  error: string | null;
  /** The first answer for this path is awaited; `data` may still hold the previous path's rows. */
  loading: boolean;
  /** The last read failed and another attempt is coming. */
  retrying: boolean;
  /** The HTTP status of a failed read; null for a network failure or no failure. */
  status: number | null;
  reload: () => void;
}

const MAX_ATTEMPTS = 5;

interface LoadFailure {
  message: string;
  status: number | null;
  attempt: number;
  retrying: boolean;
}

function loadFailure(url: string, e: unknown, retry: boolean): LoadFailure {
  const status = e instanceof HttpError ? e.status : null;
  const attempt = retry && (status === null || status >= 500) ? countFailure(url) : MAX_ATTEMPTS;
  const retrying = attempt < MAX_ATTEMPTS;
  if (!retrying) endRetryChain(url);
  return { message: errorMessage(e), status, attempt, retrying };
}

/** A package's fetch helpers over its routes under `base`. A path already under /api/ is used as given. */
export function createClient(base: string) {
  const resolve = (path: string) => (path.startsWith("/api/") ? path : `${base}${path}`);

  function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return request<T>(resolve(path), options);
  }

  /**
   * Load `path` on mount and on reload(); null loads nothing. The key is the resolved URL because the
   * cache is shared across libraries. A network failure or 5xx retries unless `retry` is false.
   */
  function useLoad<T>(path: string | null, { retry = true }: { retry?: boolean } = {}): Loaded<T> {
    const url = path === null ? null : resolve(path);
    useEffect(() => () => { if (url !== null) forgetFailures(url); }, [url]);
    const swr = useSWR<T, LoadFailure>(
      url,
      (key: string) =>
        request<T>(key).then(
          (answer) => { endRetryChain(key); return answer; },
          (e: unknown) => { throw loadFailure(key, e, retry); },
        ),
      {
        revalidateOnFocus: false,
        revalidateOnReconnect: true,
        dedupingInterval: 5000,
        keepPreviousData: true,
        onErrorRetry: (failure, key, _config, revalidate, options) => {
          if (failure.retrying) scheduleRetry(key, 2000 * 2 ** (failure.attempt - 1), () => revalidate(options));
        },
      },
    );
    const retrying = swr.error?.retrying ?? false;
    const status = swr.error?.status ?? null;
    const onSessionExpired = useContext(SessionExpiredContext);
    useEffect(() => {
      if (status === 401) onSessionExpired?.();
    }, [status, onSessionExpired]);
    const { mutate } = swr;
    const reload = useCallback(() => { void mutate(); }, [mutate]);
    return {
      data: swr.data ?? null,
      error: swr.error && !retrying ? swr.error.message : null,
      loading: swr.isLoading && !retrying,
      retrying,
      status,
      reload,
    };
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
