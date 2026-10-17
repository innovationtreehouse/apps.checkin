-- FINANCE role for the expense port (#1272 §6): RB2 "Role: Finance", a kept
-- role (references #1314 without closing it). PersonRole-table only, no legacy
-- mirror column (follows the OPERATIONS precedent).
--
-- NOT wrapped in BEGIN/COMMIT: Postgres forbids using a value added by
-- ALTER TYPE ... ADD VALUE in the same transaction that added it.

ALTER TYPE "PersonRoleKind" ADD VALUE IF NOT EXISTS 'FINANCE';
