"use client";
import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** The read side of the URL query; Next's search params and a URLSearchParams both fit. */
export type QueryParams = Pick<URLSearchParams, "get" | "toString">;

/** A list's URL changes: a null or empty value removes its key. */
export type QueryUpdates = Record<string, string | null | undefined>;

/** The page a URL asks for. A missing, non-numeric, fractional, zero or negative `page` is page 1. */
export function readPage(params: QueryParams | null): number {
  const n = Number(params?.get("page"));
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** `page` held to `last` once the list knows its last page; unknown (null) leaves it alone. */
export function clampPage(page: number, last: number | null | undefined): number {
  return last == null ? page : Math.min(page, Math.max(1, last));
}

/** `pathname` with `updates` applied to `params`, every other key kept. */
export function hrefWith(pathname: string, params: QueryParams | null, updates: QueryUpdates): string {
  const next = new URLSearchParams(params?.toString() ?? "");
  for (const [key, value] of Object.entries(updates)) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  const query = next.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function useQuery() {
  return { router: useRouter(), pathname: usePathname() ?? "", params: useSearchParams() };
}

/**
 * A paged list's page, kept in the URL's `page`. Moving to another page pushes a history entry, so
 * back returns to the page before. `last` is the list's last page when it knows its total: a page
 * past it shows the last page. A list without a total passes nothing and shows the empty page.
 */
export function useUrlPage(last?: number | null): [number, (page: number) => void] {
  const { router, pathname, params } = useQuery();
  const page = clampPage(readPage(params), last);
  const setPage = useCallback(
    (next: number) => router.push(hrefWith(pathname, params, { page: next > 1 ? String(next) : null }), { scroll: false }),
    [router, pathname, params],
  );
  return [page, setPage];
}

/**
 * Writes a list's filters, view tabs or sort to the URL. It replaces the history entry, so back
 * skips filter states, and drops `page`, so a new filter starts on page 1. Pass every key that
 * changes together in one call: two calls in one event each start from the same URL.
 */
export function useSetUrlFilters(): (updates: QueryUpdates) => void {
  const { router, pathname, params } = useQuery();
  return useCallback(
    (updates: QueryUpdates) => router.replace(hrefWith(pathname, params, { ...updates, page: null }), { scroll: false }),
    [router, pathname, params],
  );
}

/** One filter kept in the URL under `name`, such as a date or a picked person; `fallback` when absent. Setting `fallback` removes the key. */
export function useUrlFilter(name: string, fallback = ""): [string, (value: string) => void] {
  const params = useSearchParams();
  const setFilters = useSetUrlFilters();
  const value = params?.get(name) || fallback;
  const setValue = useCallback((next: string) => setFilters({ [name]: next === fallback ? null : next }), [setFilters, name, fallback]);
  return [value, setValue];
}

/**
 * A view tab, sort or other fixed choice kept in the URL under `name`. Anything not one of
 * `choices`, read or set, is `fallback`; setting `fallback` removes the key.
 */
export function useUrlChoice<T extends string>(name: string, choices: readonly T[], fallback: T): [T, (value: string | null) => void] {
  const params = useSearchParams();
  const setFilters = useSetUrlFilters();
  const value = choices.find((c) => c === params?.get(name)) ?? fallback;
  const setValue = useCallback(
    (next: string | null) => {
      const choice = choices.find((c) => c === next) ?? fallback;
      setFilters({ [name]: choice === fallback ? null : choice });
    },
    [setFilters, name, choices, fallback],
  );
  return [value, setValue];
}
