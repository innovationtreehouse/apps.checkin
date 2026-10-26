// Budget-owner buckets and their approvers route policy.
// Aggregated by ../registry.ts.
import { defineRoute, type OrderedViewEntry } from '../core';

// Every BudgetOwner field is `internal` except the owner's person id; an
// approver's id and name are `public`, as on Person. No view grants pii or personal, and no view lists
// isSysadmin: Finance Ops excludes sysadmins (docs/rules/revenue.md).
// FINANCE creates, renames and archives buckets and sets their QuickBooks Class;
// the BOARD alone sets a bucket's owner and treasurers, because they come from
// the Board-approved budget. There is no DELETE on a bucket: archive
// is soft, since library rows reference buckets by id.
const FINANCE_OR_BOARD_VIEW: readonly OrderedViewEntry[] = [
    ['isFinance', ['everyones:internal', 'public']],
    ['isBoardMember', ['everyones:internal', 'public']],
];
const FINANCE_VIEW: readonly OrderedViewEntry[] = [['isFinance', ['everyones:internal', 'public']]];
const BOARD_VIEW: readonly OrderedViewEntry[] = [['isBoardMember', ['everyones:internal', 'public']]];

// Buckets. GET omits archived rows unless `?includeArchived=1`.
defineRoute({ endpoint: 'GET /api/budget-owners', authorize: 'finance-or-board', envelope: null, returns: ['BudgetOwner'], orderedView: FINANCE_OR_BOARD_VIEW });
// QuickBooks Classes (active and inactive) for the bucket form's Class picker and
// the table's Class names.
defineRoute({ endpoint: 'GET /api/budget-owners/quickbooks-classes', authorize: 'finance-or-board', envelope: null, returns: ['QuickBooksClassOption'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'POST /api/budget-owners', authorize: 'finance', envelope: null, returns: ['BudgetOwner'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'PATCH /api/budget-owners/[id]', authorize: 'finance', envelope: null, returns: ['BudgetOwner'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'POST /api/budget-owners/[id]/archive', authorize: 'finance', envelope: null, returns: ['BudgetOwner'], orderedView: FINANCE_VIEW });

// Bucket approvers: one owner and any number of treasurers, stored on the bucket.
// FINANCE or BOARD reads them; the BOARD alone sets them, because they come from
// the Board-approved budget. approver-options lists the live people the Board may
// name (id and name only).
defineRoute({ endpoint: 'GET /api/budget-owners/[id]/approvers', authorize: 'finance-or-board', envelope: null, returns: ['BudgetOwnerApprover'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/budget-owners/approver-options', authorize: { anyRole: ['isBoardMember'] }, envelope: null, returns: ['BudgetOwnerApproverOption'], orderedView: BOARD_VIEW });
defineRoute({ endpoint: 'PUT /api/budget-owners/[id]/owner', authorize: { anyRole: ['isBoardMember'] }, envelope: null, returns: ['BudgetOwnerApprover'], orderedView: BOARD_VIEW });
defineRoute({ endpoint: 'PUT /api/budget-owners/[id]/treasurers/[personId]', authorize: { anyRole: ['isBoardMember'] }, envelope: null, returns: ['BudgetOwnerApprover'], orderedView: BOARD_VIEW });
defineRoute({ endpoint: 'DELETE /api/budget-owners/[id]/treasurers/[personId]', authorize: { anyRole: ['isBoardMember'] }, envelope: null, returns: ['BudgetOwnerApprover'], orderedView: BOARD_VIEW });

// Books map: which QuickBooks Class each bucket books to and which QuickBooks
// account each named role (a bank account, an income or donation account) books
// to (docs/in-design/QB_ENTRY_OWNERSHIP.md). FINANCE or BOARD reads it; FINANCE
// alone edits it, and every edit is audited. quickbooks-accounts lists the
// accounts for the role picker; the Class picker is quickbooks-classes above.
defineRoute({ endpoint: 'GET /api/books-map', authorize: 'finance-or-board', envelope: null, returns: ['BooksMapClass', 'BooksMapAccount'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'GET /api/books-map/quickbooks-accounts', authorize: 'finance-or-board', envelope: null, returns: ['QuickBooksAccountOption'], orderedView: FINANCE_OR_BOARD_VIEW });
defineRoute({ endpoint: 'PUT /api/books-map/classes/[budgetOwnerId]', authorize: 'finance', envelope: null, returns: ['BooksMapClass'], orderedView: FINANCE_VIEW });
defineRoute({ endpoint: 'PUT /api/books-map/accounts/[role]', authorize: 'finance', envelope: null, returns: ['BooksMapAccount'], orderedView: FINANCE_VIEW });
