-- Additive, nullable: old code neither reads nor writes it, so the drain window
-- is safe. Every existing open visit starts unstamped, i.e. unconfirmed. Kept
-- separate from forceCloseWarnedAt — the keyholder close-guard is its own
-- interrupt and both can be pending on the same visit (#1436).
ALTER TABLE "Visit" ADD COLUMN "supervisionWarnedAt" TIMESTAMP(3);
