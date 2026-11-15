-- Delete the books-map roles nothing books to any more. Their edits stay in the audit log.
BEGIN;

DELETE FROM "BooksMapRoleAccount"
WHERE "role" IN ('SHOPIFY_SALES', 'BENEVITY_DONATIONS', 'BENEVITY_MATCHES', 'BENEVITY_FEES', 'INKIND_EXPENSE', 'FIXED_ASSETS');

COMMIT;
