-- VisitSource split, stage 1 of 2: ADD the three replacement values (AT3,
-- design doc 1256_ATTENDANCE_CORRECTION_SURFACE.md §3 + "Terminology").
--
-- `SYSTEM` is deliberately KEPT. During a rolling deploy the previous release
-- keeps serving traffic against this fully-migrated schema, and it writes
-- 'SYSTEM' from three paths (events roster mark, closeAllOpenVisits, the
-- nightly cron). Removing the value here would 500 every one of them for the
-- whole drain window. Expand now; the contract (DROP the value) is a follow-up
-- release, once no deployed code can write it.
--
-- NOT wrapped in BEGIN/COMMIT, unlike most multi-statement migrations here:
-- Postgres forbids USING a value added by ALTER TYPE ... ADD VALUE in the same
-- transaction that added it. Each statement is independently idempotent and
-- additive, so a partial apply is harmless and re-runnable. The backfill that
-- depends on these values is a separate migration (…_visit_source_split_backfill)
-- precisely so it can be atomic.

ALTER TYPE "VisitSource" ADD VALUE IF NOT EXISTS 'LEAD_MARKED';
ALTER TYPE "VisitSource" ADD VALUE IF NOT EXISTS 'FACILITY_CLOSE';
ALTER TYPE "VisitSource" ADD VALUE IF NOT EXISTS 'AUTO_CLOSE';
