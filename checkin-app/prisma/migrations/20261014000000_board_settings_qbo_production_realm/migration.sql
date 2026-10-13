-- The Board-set QuickBooks production realm. Additive, nullable: NULL keeps QuickBooks off.
ALTER TABLE "BoardSettings" ADD COLUMN "qboProductionRealmId" TEXT;
