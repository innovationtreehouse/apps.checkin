-- Additive and nullable: old code that neither selects nor writes this column
-- keeps serving unchanged for the whole drain window.
ALTER TABLE "Person" ADD COLUMN "nickname" TEXT;
