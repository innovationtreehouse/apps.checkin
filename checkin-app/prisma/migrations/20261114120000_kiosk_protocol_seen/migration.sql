-- One row per kiosk signing key: the scan protocol version it last sent, and when.
BEGIN;

CREATE TABLE "KioskProtocolSeen" (
    "keyFingerprint" TEXT NOT NULL,
    "protocolVersion" INTEGER NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KioskProtocolSeen_pkey" PRIMARY KEY ("keyFingerprint")
);

COMMIT;
