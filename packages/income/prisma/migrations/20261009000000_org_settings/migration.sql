-- CreateTable
CREATE TABLE "org_settings" (
    "org_id" TEXT NOT NULL,
    "max_creates_per_run" INTEGER NOT NULL DEFAULT 25,
    "max_create_cents_per_run" INTEGER NOT NULL DEFAULT 2500000,

    CONSTRAINT "org_settings_pkey" PRIMARY KEY ("org_id")
);

