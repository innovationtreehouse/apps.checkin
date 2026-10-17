-- The membership year runs 1 September to 31 August (docs/rules/membership.md), but
-- orgMembershipYearBoundary is nullable with no default and only the settings UI has
-- ever written it. Badges print the year only for a household that settled the current
-- renewal cycle, and a null boundary fails closed to no year on any badge — so set the
-- documented boundary on the singleton that already exists in every environment.
-- Value-only and idempotent; a board-set boundary is never overwritten.
UPDATE "BoardSettings"
SET "orgMembershipYearBoundary" = DATE '2026-09-01'
WHERE "orgMembershipYearBoundary" IS NULL;
