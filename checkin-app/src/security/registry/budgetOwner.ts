// Budget-owner buckets and program treasurers (#1280 §6) route policy.
// Aggregated by ../registry.ts.
import { defineRoute, type OrderedViewEntry } from '../core';

// Every BudgetOwner field is `internal`, as is ProgramVolunteer.isTreasurer; a
// treasurer's name is `public`. No view grants pii or personal, and no view lists
// isSysadmin: Finance Ops excludes sysadmins (docs/rules/finance-payments.md).
// FINANCE creates, renames and archives buckets and sets their QuickBooks Class;
// the BOARD alone sets or clears a program treasurer, because a treasurer comes
// from the Board-approved program budget. There is no DELETE on a bucket: archive
// is soft, since library rows reference buckets by id.
const FINANCE_OR_BOARD_VIEW: readonly OrderedViewEntry[] = [
    ['isFinance', ['everyones:internal', 'public']],
    ['isBoardMember', ['everyones:internal', 'public']],
];
const FINANCE_VIEW: readonly OrderedViewEntry[] = [['isFinance', ['everyones:internal', 'public']]];
const BOARD_VIEW: readonly OrderedViewEntry[] = [['isBoardMember', ['everyones:internal', 'public']]];

// Buckets. GET omits archived rows unless `?includeArchived=1`; each row carries
// its program's id and name. program-options lists every program (drafts and
// members-only included) for the bucket form's program picker.
defineRoute({ endpoint: 'GET /api/budget-owners', authorize: 'finance-or-board', envelope: null, returns: ['BudgetOwner', 'Program'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/budget-owners/program-options', authorize: 'finance-or-board', envelope: null, returns: ['Program'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'POST /api/budget-owners', authorize: 'finance', envelope: null, returns: ['BudgetOwner'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'PATCH /api/budget-owners/[id]', authorize: 'finance', envelope: null, returns: ['BudgetOwner'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/budget-owners/[id]/archive', authorize: 'finance', envelope: null, returns: ['BudgetOwner'], orderedView: FINANCE_VIEW });

// Program treasurers. GET lists the program's volunteers with their treasurer
// flag, so the Board control can set or clear it on any of them.
defineRoute({ endpoint: 'GET /api/programs/[id]/treasurers', authorize: 'finance-or-board', envelope: null, returns: ['ProgramVolunteer', 'Person'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'PUT /api/programs/[id]/treasurers/[personId]', authorize: { anyRole: ['isBoardMember'] }, envelope: null, returns: ['ProgramVolunteer'], orderedView: BOARD_VIEW });
defineRoute({ endpoint: 'DELETE /api/programs/[id]/treasurers/[personId]', authorize: { anyRole: ['isBoardMember'] }, envelope: null, returns: ['ProgramVolunteer'], orderedView: BOARD_VIEW });
