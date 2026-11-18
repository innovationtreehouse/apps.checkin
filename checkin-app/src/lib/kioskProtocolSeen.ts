import prisma from "@/lib/prisma";

/**
 * Records a kiosk's protocol version and refreshes its last-seen time, in one
 * statement. The stored version only rises (KP-STORE: kiosks do not move back
 * to older builds), so a late request carrying an older version cannot lower it.
 * The last-seen time only rises too, so a request that took its time a moment
 * earlier cannot step it back.
 */
export async function recordKioskProtocolSeen(keyFingerprint: string, protocolVersion: number): Promise<void> {
    const now = new Date();
    await prisma.$executeRaw`
        INSERT INTO "KioskProtocolSeen" ("keyFingerprint", "protocolVersion", "lastSeenAt")
        VALUES (${keyFingerprint}, ${protocolVersion}, ${now})
        ON CONFLICT ("keyFingerprint") DO UPDATE SET
            "protocolVersion" = GREATEST("KioskProtocolSeen"."protocolVersion", EXCLUDED."protocolVersion"),
            "lastSeenAt" = GREATEST("KioskProtocolSeen"."lastSeenAt", EXCLUDED."lastSeenAt")`;
}
