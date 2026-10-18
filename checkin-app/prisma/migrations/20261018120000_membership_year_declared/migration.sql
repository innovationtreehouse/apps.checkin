BEGIN;
ALTER TABLE "OrgMembershipProcess" ADD COLUMN "appliesToYear" INTEGER;

CREATE TABLE "MembershipYearVariant" (
    "membershipYear" INTEGER NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "productUrl" TEXT,

    CONSTRAINT "MembershipYearVariant_pkey" PRIMARY KEY ("membershipYear")
);

CREATE UNIQUE INDEX "MembershipYearVariant_shopifyVariantId_key" ON "MembershipYearVariant"("shopifyVariantId");
COMMIT;
