-- The program approver signs a line by approving it, so no PROGRAM_APPROVER seat exists. A row
-- left behind would count as a seated signer; its audit rows stay as history.
BEGIN;

DELETE FROM "expense_line_signoffs" WHERE "seat" = 'PROGRAM_APPROVER';

COMMIT;
