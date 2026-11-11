"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useViewer } from "@checkin/component-ui";
import { NAV_COUNTS_EVENT } from "@/lib/nav-refresh";
import type { TodoCounts, TodoCountsResponse } from "@/lib/nav/todoCounts";

// One shared snapshot for every consumer (nav badge, sub-nav tabs, todo card), so
// they cannot show different numbers from fetches at slightly different times.
// It is tagged with the viewer it was read for: another tab can change the session
// without a page load, and one person's counts must never show to the next. The
// server answers for whoever holds the cookie, so a read is kept only when the
// person it answered for is the viewer it was asked for.
let counts: { viewerId: number; value: TodoCounts } | null = null;
let inFlight = false;
let queued: { viewerId: number } | null = null;
const listeners = new Set<() => void>();

function emit() {
    for (const listener of listeners) listener();
}

function fetchCounts(viewerId: number) {
    // Dedupe concurrent fetches; if a refresh event arrives mid-flight, run one
    // more pass afterward so the latest mutation is reflected.
    if (inFlight) {
        queued = { viewerId };
        return;
    }
    inFlight = true;
    fetch("/api/nav/todo-counts")
        .then((res) => (res.ok ? res.json() : null))
        .then((data: TodoCountsResponse | null) => {
            if (!data) return;
            const { personId, ...value } = data;
            if (personId !== viewerId) return;
            counts = { viewerId, value };
            emit();
        })
        .catch(() => {
            // Badges are best-effort; a failed fetch just leaves the last value.
        })
        .finally(() => {
            inFlight = false;
            const next = queued;
            queued = null;
            if (next) fetchCounts(next.viewerId);
        });
}

/**
 * Read nav todo-count badges, kept live and consistent across all consumers.
 * Refetches on mount, when the viewer changes, and whenever a mutation site fires
 * NAV_COUNTS_EVENT (see src/lib/nav-refresh.ts). Returns null until the first
 * response for the current viewer, when signed out, and when disabled.
 */
export function useTodoCounts(enabled: boolean): TodoCounts | null {
    const viewerId = useViewer()?.id ?? null;
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
        if (!enabled || viewerId === null) return;
        fetchCounts(viewerId);
        const handler = () => fetchCounts(viewerId);
        window.addEventListener(NAV_COUNTS_EVENT, handler);
        return () => window.removeEventListener(NAV_COUNTS_EVENT, handler);
    }, [enabled, viewerId]);

    return enabled && viewerId !== null && snapshot?.viewerId === viewerId ? snapshot.value : null;
}
