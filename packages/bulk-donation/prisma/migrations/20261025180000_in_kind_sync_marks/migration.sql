BEGIN;

-- CreateTable
CREATE TABLE "in_kind_sync_marks" (
    "org_id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,

    CONSTRAINT "in_kind_sync_marks_pkey" PRIMARY KEY ("org_id","receipt_id")
);

COMMIT;
