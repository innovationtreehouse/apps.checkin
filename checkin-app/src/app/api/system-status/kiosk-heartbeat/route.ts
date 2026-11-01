import { handler } from "@/security/handler";
import { getKioskClockSkew, getKioskSeen } from "@/lib/kioskSeen";

// Registry-governed (GET /api/system-status/kiosk-heartbeat): admission anyRole
// sysadmin/board; envelope 'heartbeat'. The readings are in-memory (no DB row),
// so the bag holds synthesized SystemMetricLog rows, each present only when it
// has a reading. `kiosk_last_seen`: timestamp = last accepted kiosk request,
// value = age in seconds. `kiosk_clock_skew`: timestamp = when noted, value =
// kiosk clock minus server clock in seconds. A kiosk refused for its clock has
// a skew row and possibly no last-seen row.

export const GET = handler("GET /api/system-status/kiosk-heartbeat", async () => {
    const seen = getKioskSeen();
    const skew = getKioskClockSkew();
    return {
        SystemMetricLog: [
            ...(seen.lastSeenAt != null && seen.ageSeconds != null
                ? [{ metric: "kiosk_last_seen", timestamp: seen.lastSeenAt, value: seen.ageSeconds }]
                : []),
            ...(skew ? [{ metric: "kiosk_clock_skew", timestamp: skew.at, value: skew.seconds }] : []),
        ],
    };
});
