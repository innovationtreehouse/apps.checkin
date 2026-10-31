"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { NAV_COUNTS_EVENT } from "@/lib/nav-refresh";
import type { TodoCounts } from "@/lib/nav/todoCounts";

// One shared snapshot for every consumer (nav badge, sub-nav tabs, todo card), so
// they cannot show different numbers from fetches at slightly different times.
let counts: TodoCounts | null = null;
let inFlight: Promise<void> | null = null;
let refetchQueued = false;
const listeners = new Set<() => void>();

function emit() {
    for (const listener of listeners) listener();
}

function fetchCounts() {
    // Dedupe concurrent fetches; if a refresh event arrives mid-flight, run one
    // more pass afterward so the latest mutation is reflected.
    if (inFlight) {
        refetchQueued = true;
        return;
    }
    inFlight = fetch("/api/nav/todo-counts")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
            if (data) {
                counts = data as TodoCounts;
                emit();
            }
        })
        .catch(() => {
            // Badges are best-effort; a failed fetch just leaves the last value.
        })
        .finally(() => {
            inFlight = null;
            if (refetchQueued) {
                refetchQueued = false;
                fetchCounts();
            }
        });
}

/**
 * Read nav todo-count badges, kept live and consistent across all consumers.
 * Refetches on mount and whenever a mutation site fires NAV_COUNTS_EVENT (see
 * src/lib/nav-refresh.ts). Returns null until the first response and when disabled.
 */
export function useTodoCounts(enabled: boolean): TodoCounts | null {
    const subscribe = useCallback((onChange: () => void) => {
        listeners.add(onChange);
        return () => listeners.delete(onChange);
    }, []);
    const snapshot = useSyncExternalStore(
        subscribe,
        () => counts,
        () => null,
    );

    useEffect(() => {
        if (!enabled) return;
        fetchCounts();
        const handler = () => fetchCounts();
        window.addEventListener(NAV_COUNTS_EVENT, handler);
        return () => window.removeEventListener(NAV_COUNTS_EVENT, handler);
    }, [enabled]);

    // When disabled (e.g. signed out) report no counts rather than a stale value.
    return enabled ? snapshot : null;
}
