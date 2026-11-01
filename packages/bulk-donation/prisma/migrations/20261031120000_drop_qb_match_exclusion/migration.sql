-- Income owns every deposit, and no deployed release reads this table.
BEGIN;

DROP TABLE "qb_match_exclusion";

COMMIT;
