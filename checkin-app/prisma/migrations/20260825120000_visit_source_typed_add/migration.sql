-- #1624 expand: add TYPED (a clock typed into a form — capture method, not
-- actor). WEB stays: rolling-deploy old tasks still write it, and historical
-- rows are not guessed. Writers switch in a follow-up once this value is on
-- every live task. LEAD_MARKED is not backfilled (roster window vs staff-typed
-- time cannot be told apart).
--
-- NOT wrapped in BEGIN/COMMIT: Postgres forbids USING a value added by
-- ALTER TYPE ... ADD VALUE in the same transaction that added it.

ALTER TYPE "VisitSource" ADD VALUE IF NOT EXISTS 'TYPED';
