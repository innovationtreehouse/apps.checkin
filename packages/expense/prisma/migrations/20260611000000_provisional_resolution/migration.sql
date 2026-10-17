-- CreateTable
CREATE TABLE "provisional_resolutions" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "provisional_gtin13" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "real_gtin13" TEXT,
    "rejection_reason" TEXT,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_event_id" INTEGER,

    CONSTRAINT "provisional_resolutions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "provisional_resolutions_org_id_provisional_gtin13_key" ON "provisional_resolutions"("org_id", "provisional_gtin13");
