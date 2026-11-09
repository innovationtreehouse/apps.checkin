BEGIN;

-- CreateTable
CREATE TABLE "QboFaultCodeSeen" (
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLane" TEXT NOT NULL,

    CONSTRAINT "QboFaultCodeSeen_pkey" PRIMARY KEY ("code","kind")
);

COMMIT;
