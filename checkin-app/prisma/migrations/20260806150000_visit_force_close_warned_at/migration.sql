-- Additive, nullable: old code neither reads nor writes it, so the drain window
-- is safe. Every existing open visit starts unstamped, i.e. unconfirmed.
ALTER TABLE "Visit" ADD COLUMN "forceCloseWarnedAt" TIMESTAMP(3);
