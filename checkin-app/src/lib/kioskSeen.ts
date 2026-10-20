/**
 * In-memory kiosk last-seen stamp, and the client builds seen reporting in.
 *
 * Updated on every verified kiosk signature — zero new requests, zero DB
 * writes, so it cannot wake the curfewed service or pin Aurora. Dies with
 * the task overnight (scale-to-zero); the panel then correctly reads
 * stale-during-curfew. Deliberately free of the prisma import graph.
 *
 * The build comes from the X-Kiosk-Version header the kiosk sends on every
 * request (`<release>+<content digest>`, see client/version.py). The signature
 * covers ts:nonce:method:path:body and NOT the headers, so this value is
 * unauthenticated telemetry: it is reported and logged, never used to decide
 * anything. It is length-capped and charset-checked, and the map is bounded,
 * so a malformed or tampered header cannot grow memory or a log line.
 */

const MAX_VERSION_CHARS = 64;
const MAX_TRACKED_VERSIONS = 16;

let lastSeenAtMs: number | null = null;
// version -> the last time a request reporting it verified.
const versionsSeen = new Map<string, number>();

function normalizeVersion(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const trimmed = raw.trim().slice(0, MAX_VERSION_CHARS);
    return /^[A-Za-z0-9._+-]+$/.test(trimmed) ? trimmed : null;
}

export function stampKioskSeen(nowMs: number = Date.now(), version?: string | null): void {
    lastSeenAtMs = nowMs;

    const build = normalizeVersion(version);
    if (build == null) return;

    // One line the first time a build reports in — the upgrade/rollback trail
    // in CloudWatch, without a write per request.
    if (!versionsSeen.has(build)) {
        console.info(`[kiosk] build reporting in: ${build}`);
    }
    versionsSeen.set(build, nowMs);

    // Evict the stalest rather than the oldest-inserted: a kiosk still
    // reporting re-adds itself on its next request, so the cap costs at most a
    // repeated log line.
    if (versionsSeen.size > MAX_TRACKED_VERSIONS) {
        let stalest: string | null = null;
        let stalestAt = Infinity;
        for (const [seenBuild, seenAt] of versionsSeen) {
            if (seenAt < stalestAt) {
                stalest = seenBuild;
                stalestAt = seenAt;
            }
        }
        if (stalest != null) versionsSeen.delete(stalest);
    }
}

export function getKioskSeen(nowMs: number = Date.now()): {
    lastSeenAt: Date | null;
    ageSeconds: number | null;
    versions: { version: string; lastSeenAt: Date; ageSeconds: number }[];
} {
    // Most recently seen build first — a fleet mid-rollout reports more than
    // one, and the newest arrival is the interesting row.
    const versions = [...versionsSeen.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([version, seenAtMs]) => ({
            version,
            lastSeenAt: new Date(seenAtMs),
            ageSeconds: Math.max(0, Math.floor((nowMs - seenAtMs) / 1000)),
        }));

    if (lastSeenAtMs == null) return { lastSeenAt: null, ageSeconds: null, versions };
    return {
        lastSeenAt: new Date(lastSeenAtMs),
        ageSeconds: Math.max(0, Math.floor((nowMs - lastSeenAtMs) / 1000)),
        versions,
    };
}

/** Test-only. */
export function resetKioskSeen(): void {
    lastSeenAtMs = null;
    versionsSeen.clear();
}
