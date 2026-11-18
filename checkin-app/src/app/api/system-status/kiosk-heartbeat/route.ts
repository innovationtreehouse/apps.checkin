import { handler } from "@/security/handler";
import prisma from "@/lib/prisma";
import { getKioskClockSkew, getKioskSeen } from "@/lib/kioskSeen";
import { getKioskPublicKeys, kioskKeyFingerprint } from "@/lib/verify-kiosk";

// Registry-governed (GET /api/system-status/kiosk-heartbeat): admission anyRole
// sysadmin/board; envelope 'heartbeat'. KioskProtocolSeen is the stored row per
// kiosk key. The other readings are in-memory, so they go out as synthesized
// SystemMetricLog rows, each present only when it has a reading.
// `kiosk_last_seen`: timestamp = last accepted kiosk request, value = age in
// seconds. `kiosk_clock_skew`: timestamp = when noted, value = kiosk clock minus
// server clock in seconds. `kiosk_key:<fingerprint>`: one per key configured in
// KIOSK_PUBLIC_KEY, so the box can mark a stored row whose key was removed.

export const GET = handler("GET /api/system-status/kiosk-heartbeat", async () => {
    const seen = getKioskSeen();
    const skew = getKioskClockSkew();
    const now = new Date();
    const protocolSeen = await prisma.kioskProtocolSeen.findMany({
        select: { keyFingerprint: true, protocolVersion: true, lastSeenAt: true },
        orderBy: { lastSeenAt: "desc" },
    });
    return {
        SystemMetricLog: [
            ...(seen.lastSeenAt != null && seen.ageSeconds != null
                ? [{ metric: "kiosk_last_seen", timestamp: seen.lastSeenAt, value: seen.ageSeconds }]
                : []),
            ...(skew ? [{ metric: "kiosk_clock_skew", timestamp: skew.at, value: skew.seconds }] : []),
            ...getKioskPublicKeys().map((key) => ({ metric: `kiosk_key:${kioskKeyFingerprint(key)}`, timestamp: now, value: 1 })),
        ],
        KioskProtocolSeen: protocolSeen,
    };
});
