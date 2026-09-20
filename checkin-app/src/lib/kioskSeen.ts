/**
 * In-memory kiosk last-seen stamp.
 *
 * Updated on every verified kiosk signature — zero new requests, zero DB
 * writes, so it cannot wake the curfewed service or pin Aurora. Dies with
 * the task overnight (scale-to-zero); the panel then correctly reads
 * stale-during-curfew.
 */

let lastSeenAtMs: number | null = null;

export function stampKioskSeen(nowMs: number = Date.now()): void {
    lastSeenAtMs = nowMs;
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

/** Test-only. */
export function resetKioskSeen(): void {
    lastSeenAtMs = null;
}
