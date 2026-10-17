import { handler } from "@/security/handler";
import { getKioskSeen } from "@/lib/kioskSeen";

// Registry-governed (GET /api/system-status/kiosk-heartbeat): admission anyRole
// sysadmin/board; envelope 'heartbeat'. The stamp is in-memory (no DB row),
// so the bag is a synthesized SystemMetricLog: metric `kiosk_last_seen`,
// timestamp = last verified kiosk request, value = age in seconds. An empty
// array means this task has not seen a kiosk since it started.

export const GET = handler("GET /api/system-status/kiosk-heartbeat", async () => {
    const seen = getKioskSeen();
    if (seen.lastSeenAt == null || seen.ageSeconds == null) {
        return { SystemMetricLog: [] };
    }
    return {
        SystemMetricLog: [
            {
                metric: "kiosk_last_seen",
                timestamp: seen.lastSeenAt,
                value: seen.ageSeconds,
            },
        ],
    };
});
