-- CreateTable
CREATE TABLE "org_audit_log" (
    "id" SERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "actor_user_id" INTEGER NOT NULL,
    "actor_username" TEXT,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "action" TEXT NOT NULL,
    "before" TEXT,
    "after" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "org_audit_log_org_id_idx" ON "org_audit_log"("org_id");
