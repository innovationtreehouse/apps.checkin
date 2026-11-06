"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useViewer } from "@checkin/component-ui";
import { NAV_COUNTS_EVENT } from "@/lib/nav-refresh";
import type { TodoCounts } from "@/lib/nav/todoCounts";

type ViewerId = number | null;

// One shared snapshot for every consumer (nav badge, sub-nav tabs, todo card), so
// they cannot show different numbers from fetches at slightly different times.
// It is tagged with the viewer it was read for: another tab can change the session
// without a page load, and one person's counts must never show to the next.
let counts: { viewerId: ViewerId; value: TodoCounts } | null = null;
let inFlight = false;
let queued: { viewerId: ViewerId } | null = null;
const listeners = new Set<() => void>();

function emit() {
    for (const listener of listeners) listener();
}

function fetchCounts(viewerId: ViewerId) {
    // Dedupe concurrent fetches; if a refresh event arrives mid-flight, run one
    // more pass afterward so the latest mutation is reflected.
    if (inFlight) {
        queued = { viewerId };
        return;
    }
    inFlight = true;
    fetch("/api/nav/todo-counts")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
            if (data) {
                counts = { viewerId, value: data as TodoCounts };
                emit();
            }
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
 * response for the current viewer and when disabled.
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
        if (!enabled) return;
        fetchCounts(viewerId);
        const handler = () => fetchCounts(viewerId);
        window.addEventListener(NAV_COUNTS_EVENT, handler);
        return () => window.removeEventListener(NAV_COUNTS_EVENT, handler);
    }, [enabled, viewerId]);

    // When disabled (e.g. signed out) report no counts rather than a stale value.
    return enabled && snapshot?.viewerId === viewerId ? snapshot.value : null;
}
