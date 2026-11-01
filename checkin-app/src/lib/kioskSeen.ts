/**
 * In-memory kiosk last-seen stamp.
 *
 * Updated on every verified kiosk signature — zero new requests, zero DB
 * writes, so it cannot wake the curfewed service or pin Aurora. Dies with
 * the task overnight (scale-to-zero); the panel then correctly reads
 * stale-during-curfew.
 *
 * ponytail: per-process. One ECS task today; with several, a request landing
 * on a task the kiosk is not polling reads "can't confirm" — move the stamp to
 * a shared store if the service ever runs more than one task.
 */

let lastSeenAtMs: number | null = null;
let queuedScans = 0;

/**
 * How recent a signed kiosk request must be for the web to state building
 * state as fact. While anyone is inside, or the kiosk doesn't know, its display
 * polls /api/attendance (signed by the Pi's proxy) once a minute, so five
 * minutes of silence means the server cannot reach the building. In a building
 * the kiosk knows is empty it sends nothing on purpose, and this reads
 * unreachable then, as it should.
 */
export const KIOSK_FRESH_MS = 5 * 60_000;

/** Reads X-Kiosk-Queue-Depth. A kiosk that sends none (or a malformed value) reports no backlog. */
export function parseQueueDepth(header: string | null | undefined): number {
    if (!header || !/^\d+$/.test(header)) return 0;
    const depth = Number(header);
    return Number.isSafeInteger(depth) ? depth : 0;
}

export function stampKioskSeen(nowMs: number = Date.now(), queued: number = 0): void {
    lastSeenAtMs = nowMs;
    queuedScans = queued;
}

export function getKioskSeen(nowMs: number = Date.now()): {
    lastSeenAt: Date | null;
    ageSeconds: number | null;
} {
    if (lastSeenAtMs == null) return { lastSeenAt: null, ageSeconds: null };
    return {
        lastSeenAt: new Date(lastSeenAtMs),
        ageSeconds: Math.max(0, Math.floor((nowMs - lastSeenAtMs) / 1000)),
    };
}

export type BuildingLink = { reachable: boolean; lastSeenAt: string | null; queued: number };

/**
 * Whether the server can currently talk to the building's kiosk. Web surfaces
 * that state occupancy, open/closed or supervision as fact render them only
 * when `reachable`; otherwise they say the building state can't be confirmed.
 * A kiosk with scans still queued is not `reachable`: the server's record is
 * behind the door by those scans, and `queued` counts them. A stale heartbeat
 * reports no count, because the last one heard says nothing about now.
 */
export function buildingLink(nowMs: number = Date.now()): BuildingLink {
    const fresh = lastSeenAtMs != null && nowMs - lastSeenAtMs <= KIOSK_FRESH_MS;
    return {
        reachable: fresh && queuedScans === 0,
        lastSeenAt: lastSeenAtMs == null ? null : new Date(lastSeenAtMs).toISOString(),
        queued: fresh ? queuedScans : 0,
    };
}

/** Test-only. */
export function resetKioskSeen(): void {
    lastSeenAtMs = null;
    queuedScans = 0;
}
