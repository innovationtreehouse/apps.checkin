// The income section's gate: FINANCE works the screens, BOARD reads them. No
// sysadmin: Finance Ops excludes sysadmins (docs/rules/finance-payments.md).
// Mirrors the routes' finance-or-board gate.
export const INCOME_SECTION_ROLES = ["isFinance", "isBoardMember"] as const;
