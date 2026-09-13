-- Interim RBAC role for the global-catalog port (#1286, design PR #1814):
-- collapses the source's global-manager + org-manager into one manager tier.
-- References #1316 (RB4 Catalog/Org split) without closing it. PersonRole-table
-- only, no legacy mirror column (follows the OPERATIONS precedent).
--
-- NOT wrapped in BEGIN/COMMIT: Postgres forbids using a value added by
-- ALTER TYPE ... ADD VALUE in the same transaction that added it.

ALTER TYPE "PersonRoleKind" ADD VALUE IF NOT EXISTS 'INVENTORY_MANAGER';
