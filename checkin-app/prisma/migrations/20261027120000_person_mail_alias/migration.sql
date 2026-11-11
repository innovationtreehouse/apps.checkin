-- Extra addresses a person's receipt mail may come from. Additive only: a new
-- table; no existing row or column changes.
BEGIN;

-- CreateTable
CREATE TABLE "PersonMailAlias" (
    "id" SERIAL NOT NULL,
    "personId" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "canonicalKey" TEXT NOT NULL,
    "addedById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "approvedById" INTEGER,

    CONSTRAINT "PersonMailAlias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PersonMailAlias_address_key" ON "PersonMailAlias"("address");

-- CreateIndex
CREATE INDEX "PersonMailAlias_canonicalKey_idx" ON "PersonMailAlias"("canonicalKey");

-- CreateIndex
CREATE INDEX "PersonMailAlias_personId_idx" ON "PersonMailAlias"("personId");

-- AddForeignKey
ALTER TABLE "PersonMailAlias" ADD CONSTRAINT "PersonMailAlias_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
