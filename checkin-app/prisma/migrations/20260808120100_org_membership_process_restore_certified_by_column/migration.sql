-- Puts the column back on its original name. The Prisma field stays
-- `manualPaymentById` and reaches it through @map, so the previous release —
-- which serves traffic against this schema for the whole rolling-deploy drain
-- window — keeps reading OrgMembershipProcess (rule 3).
--
-- Timestamp deliberately sorts immediately after 20260808120000 (the forward
-- rename), not at the end of the chain: `migrate deploy` runs the chain
-- sequentially and unwrapped, so anything in between — a DROP, an index build —
-- leaves the column on its new name for that long, and old code 500s meanwhile.
ALTER TABLE "OrgMembershipProcess" RENAME COLUMN "manualPaymentById" TO "certifiedById";
