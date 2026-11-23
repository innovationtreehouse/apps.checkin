"use client";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Alert, Button, Group, Pagination, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import useSWR, { useSWRConfig } from "swr";
import { answeredAt, clearLoads, countFailure, endRetryChain, forgetFailures, holdFromInvalidation, invalidateLoads, loadGeneration, scheduleRetry, stampAnswer, subscribeAnswers } from "./loadCache";
import { errorMessage, FAILURE_TEXT, HttpError, NETWORK_FAILURE_TEXT, request, requestAnswer, type RequestOptions } from "./http";

export { invalidateLoads };
export { errorMessage, FAILURE_TEXT, HttpError, NETWORK_FAILURE_TEXT, request, type RequestOptions };

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


export interface Loaded<T> {
  data: T | null;
  /** Null while the first answer for this path is awaited or a retry is pending. */
  error: string | null;
  /** The first answer for this path is awaited; with `keepPrevious`, `data` may still hold the previous path's rows. */
  loading: boolean;
  /** The last read failed and another attempt is coming. */
  retrying: boolean;
  /** The HTTP status of a failed read; null for a network failure or no failure. */
  status: number | null;
  /** The latest answer was 204 No Content; `data` still holds the last answer that had a body. */
  resting: boolean;
  /** When the last answer with a body arrived, in epoch milliseconds; null unless `stampAnswers` is set. */
  answeredAt: number | null;
  /** Settles once the re-read has answered, and never rejects: a failed read lands in `error`. */
  reload: () => Promise<void>;
}

const MAX_ATTEMPTS = 5;

interface LoadFailure {
  message: string;
  status: number | null;
  attempt: number;
  retrying: boolean;
}

/** One answer as the cache holds it: a 204 carries the previous body forward. */
interface Answered<T> {
  body: T | null;
  resting: boolean;
}

/** The cache key: the URL alone, or the URL and its headers, so a signed answer never reaches an unsigned reader. */
function loadKey(url: string, headers: Record<string, string> | undefined): string {
  const entries = Object.entries(headers ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? `${url} ${JSON.stringify(entries)}` : url;
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
   * A new path starts at null, so one parent's rows never show with another's buttons. `keepPrevious`
   * is for a pager or search box, whose rows each act on their own id; it never keeps an empty list.
   * `expireOn401: false` is for a read mounted on every page: routes also answer 401 to a session
   * next-auth reports as signed in, such as a denied household, so it must not move anyone.
   * `reconnect: false` and `skipWriteReload: true` are for a read that logs a view or wakes a sleeping
   * database: no re-read on reconnect, and none after another page's write; `reload()` still re-reads.
   * `headers` go on every read of this load, and are part of its cache key. `stampAnswers` reports
   * `answeredAt` and re-renders on every answer, even one identical to the last.
   */
  function useLoad<T>(
    path: string | null,
    { retry = true, keepPrevious = false, expireOn401 = true, reconnect = true, skipWriteReload = false, headers, stampAnswers = false }: { retry?: boolean; keepPrevious?: boolean; expireOn401?: boolean; reconnect?: boolean; skipWriteReload?: boolean; headers?: Record<string, string>; stampAnswers?: boolean } = {},
  ): Loaded<T> {
    const url = path === null ? null : resolve(path);
    const key = url === null ? null : loadKey(url, headers);
    useEffect(() => () => { if (key !== null) forgetFailures(key); }, [key]);
    useEffect(() => (key !== null && skipWriteReload ? holdFromInvalidation(key) : undefined), [key, skipWriteReload]);
    const { cache } = useSWRConfig();
    const swr = useSWR<Answered<T>, LoadFailure>(
      key,
      url === null ? null : (cacheKey: string) =>
        requestAnswer<T>(url, headers ? { headers } : {}).then(
          ({ status, data }): Answered<T> => {
            endRetryChain(cacheKey);
            if (status !== 204) {
              stampAnswer(cacheKey);
              return { body: data, resting: false };
            }
            const previous: Answered<T> | undefined = cache.get(cacheKey)?.data;
            return { body: previous?.body ?? null, resting: true };
          },
          (e: unknown) => { throw loadFailure(cacheKey, e, retry); },
        ),
      {
        revalidateOnFocus: false,
        revalidateOnReconnect: reconnect,
        dedupingInterval: 5000,
        onErrorRetry: (failure, key, _config, revalidate, options) => {
          if (failure.retrying) scheduleRetry(key, 2000 * 2 ** (failure.attempt - 1), () => revalidate(options));
        },
      },
    );
    const stamped = key !== null && stampAnswers ? key : null;
    const subscribeStamp = useCallback((listener: () => void) => (stamped === null ? () => {} : subscribeAnswers(stamped, listener)), [stamped]);
    const stampedAt = useSyncExternalStore(subscribeStamp, () => (stamped === null ? null : answeredAt(stamped)), () => null);
    const generation = loadGeneration();
    const body = swr.data === undefined ? undefined : swr.data.body;
    const [kept, setKept] = useState<{ data: T | null; generation: number } | null>(null);
    if (keepPrevious && body !== undefined && kept?.data !== body) setKept({ data: body, generation });
    const previous = keepPrevious && key !== null && kept?.generation === generation && !(Array.isArray(kept.data) && kept.data.length === 0) ? kept.data : null;
    const retrying = swr.error?.retrying ?? false;
    const status = swr.error?.status ?? null;
    const onSessionExpired = useContext(SessionExpiredContext);
    useEffect(() => {
      if (status === 401 && expireOn401) onSessionExpired?.();
    }, [status, expireOn401, onSessionExpired]);
    const { mutate } = swr;
    const reload = useCallback(() => mutate().then(() => undefined, () => undefined), [mutate]);
    return {
      data: body !== undefined ? body : previous,
      error: swr.error && !retrying ? swr.error.message : null,
      loading: swr.isLoading && !retrying,
      retrying,
      status,
      resting: swr.data?.resting ?? false,
      answeredAt: stampedAt,
      reload,
    };
  }

  return { api, useLoad };
}

/** The error code of a save refused because the app's copy of QuickBooks' lists lacks the pick; `@checkin/quickbooks` sets it. */
export const QUICKBOOKS_LIST_STALE = "quickbooks-list-stale";

/** One saved QuickBooks list, as GET /api/books-map/quickbooks-lists returns it. */
interface QuickBooksListStatus {
  list: string;
  refreshedAt: string;
  entries: number;
}

const hostRoutes = createClient("/api");

const asOf = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

/**
 * When the app last copied QuickBooks' account and Class lists, and an "Update now" control that copies them again.
 * A successful update re-reads every cached load, so pickers fed by `useLoad` refresh themselves; `onRefreshed`
 * is for a page that loads its options another way.
 */
export function QuickBooksListsRefresh({ onRefreshed }: { onRefreshed?: () => void }) {
  const status = hostRoutes.useLoad<QuickBooksListStatus[]>("/api/books-map/quickbooks-lists", { retry: false });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const lists = Array.isArray(status.data) ? status.data : [];
  const oldest = lists.map((s) => s.refreshedAt).sort()[0];

  async function update() {
    setBusy(true);
    setFailed(null);
    try {
      await request("/api/books-map/quickbooks-lists/refresh", { method: "POST" });
      onRefreshed?.();
    } catch (e) {
      setFailed(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Group gap="xs" wrap="wrap">
      <Text size="sm" c="dimmed">
        {status.data === null ? "QuickBooks lists" : oldest ? `QuickBooks lists as of ${asOf(oldest)}` : "QuickBooks lists not copied yet"}
      </Text>
      <Button size="xs" variant="light" loading={busy} onClick={() => void update()}>Update now</Button>
      {failed && <Text size="sm" c="red">{failed}</Text>}
    </Group>
  );
}

/**
 * A saved QuickBooks pick the app's copy shows as inactive or no longer holds, as a warning with `advice` and
 * "Update now"; pickers never offer it. Nothing while the pick is active, unset, or the list isn't loaded.
 */
export function InactivePickWarning({ saved, options, onRefreshed, advice }: {
  saved: string | null | undefined;
  options: readonly { id: string; name: string; active: boolean }[] | null | undefined;
  onRefreshed?: () => void;
  /** What to do about it: "Pick an active one." beside a picker; a row with no picker names its own fix. */
  advice: string;
}) {
  if (!saved || !options?.length) return null;
  const entry = options.find((o) => o.id === saved);
  if (entry?.active) return null;
  return (
    <Alert color="yellow" variant="light" p="xs">
      <Text size="sm">{entry ? `${entry.name} is inactive in QuickBooks.` : `QuickBooks id ${saved} is not in QuickBooks' list in the app.`} {advice}</Text>
      <QuickBooksListsRefresh onRefreshed={onRefreshed} />
    </Alert>
  );
}

/** A refusal's words for a toast or alert; a save refused against an out-of-date QuickBooks list also offers "Update now". */
export function refusalMessage(e: unknown, { onRefreshed }: { onRefreshed?: () => void } = {}): ReactNode {
  const message = errorMessage(e);
  if (!(e instanceof HttpError) || e.code !== QUICKBOOKS_LIST_STALE) return message;
  return (
    <>
      {message}
      <QuickBooksListsRefresh onRefreshed={onRefreshed} />
    </>
  );
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

/** An action that worked: goes away by itself, and waits its turn with a screen reader. */
export function showSuccess(message: string, { title }: { title?: string } = {}): void {
  notifications.show({ color: "green", role: "status", title, message });
}

type StickyOptions = { key?: string; title?: string };

/**
 * A keyed message, sticky unless `autoClose` gives it milliseconds. The same `key` changes the message
 * in place, so a repeat from a poll neither animates nor announces again; `show` ignores an id already
 * on screen. A string message is its own key when none is given.
 */
function showKeyed(color: string, message: ReactNode, { key, title }: StickyOptions, autoClose: number | false = false): void {
  const id = key ?? (typeof message === "string" ? message : undefined);
  if (id) notifications.update({ id, title, message });
  notifications.show({ id, color, title, message, autoClose });
}

/** An action that failed. `message` is the server's chosen words or fixed text, never exception text. */
export function showError(message: ReactNode, options: StickyOptions = {}): void {
  showKeyed("red", message, options);
}

/** Something a save leaves the person to read that is not a failure: yellow, and stays until dismissed unless `autoClose` gives milliseconds. */
export function showWarning(message: ReactNode, { autoClose = false, ...options }: StickyOptions & { autoClose?: number | false } = {}): void {
  showKeyed("yellow", message, options, autoClose);
}

/** Removes the standing error under `key`, once a retry or a later attempt worked. */
export function clearError(key: string): void {
  notifications.hide(key);
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

export * from "./urlState";
export * from "./catalogNames";
export * from "./catalogPicker";
