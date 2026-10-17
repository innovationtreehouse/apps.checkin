-- Hand-written RENAME (never Prisma's generated DROP+ADD, which would silently
-- drop the recorded actor on a populated table — see
-- docs/DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md rule 4).
ALTER TABLE "OrgMembershipProcess" RENAME COLUMN "certifiedById" TO "manualPaymentById";
