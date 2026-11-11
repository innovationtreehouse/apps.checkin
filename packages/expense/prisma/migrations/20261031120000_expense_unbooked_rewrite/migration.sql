BEGIN;

UPDATE "expenses" SET "qb_match_state" = 'UNBOOKED' WHERE "qb_match_state" = 'BEFORE_LINE';
UPDATE "expense_line_items" SET "qb_match_state" = 'UNBOOKED' WHERE "qb_match_state" = 'BEFORE_LINE';

COMMIT;
