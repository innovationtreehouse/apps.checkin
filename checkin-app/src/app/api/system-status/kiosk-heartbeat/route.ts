import { handler } from "@/security/handler";
import { getKioskSeen } from "@/lib/kioskSeen";

// Registry-governed (GET /api/system-status/kiosk-heartbeat): admission anyRole
// sysadmin/board; envelope 'heartbeat'. The stamp is in-memory (no DB row),
// so the bag is a synthesized SystemMetricLog: metric `kiosk_last_seen`,
// timestamp = last verified kiosk request, value = age in seconds. An empty
// array means this task has not seen a kiosk since it started.
//
// Each kiosk build that has reported in adds a `kiosk_version:<build>` row.
// The build string rides in the metric NAME because `metric` is the only
// non-numeric column SystemMetricLog has — the shape the registry already
// grants. More than one such row means the fleet is mid-rollout or a Pi is
// stuck on an old build.

type HeartbeatRow = { metric: string; timestamp: Date; value: number };

export const GET = handler("GET /api/system-status/kiosk-heartbeat", async () => {
    const seen = getKioskSeen();
    const rows: HeartbeatRow[] = [];

    if (seen.lastSeenAt != null && seen.ageSeconds != null) {
        rows.push({
            metric: "kiosk_last_seen",
            timestamp: seen.lastSeenAt,
            value: seen.ageSeconds,
        });
    }

    for (const build of seen.versions) {
        rows.push({
            metric: `kiosk_version:${build.version}`,
            timestamp: build.lastSeenAt,
            value: build.ageSeconds,
        });
    }

    return { SystemMetricLog: rows };
});
