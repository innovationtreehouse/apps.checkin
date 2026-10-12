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

/**
 * How recent a signed kiosk request must be for the web to state building
 * state as fact. Daytime, the kiosk's display polls /api/attendance (signed
 * by the Pi's proxy) once a minute whether or not anyone is inside, so five
 * minutes of silence means the server cannot reach the building. Overnight (23:00–06:00 kiosk local time) the kiosk stops polling
 * on purpose and this reads unreachable, as it should.
 */
export const KIOSK_FRESH_MS = 5 * 60_000;

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

export type BuildingLink = { reachable: boolean; lastSeenAt: string | null };

/**
 * Whether the server can currently talk to the building's kiosk. Web surfaces
 * that state occupancy, open/closed or supervision as fact render them only
 * when `reachable`; otherwise they say the building state can't be confirmed.
 */
export function buildingLink(nowMs: number = Date.now()): BuildingLink {
    return {
        reachable: lastSeenAtMs != null && nowMs - lastSeenAtMs <= KIOSK_FRESH_MS,
        lastSeenAt: lastSeenAtMs == null ? null : new Date(lastSeenAtMs).toISOString(),
    };
}

/** Test-only. */
export function resetKioskSeen(): void {
    lastSeenAtMs = null;
}
