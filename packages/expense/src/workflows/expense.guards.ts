import type { ExpenseEvent } from './expense.events';

export type ExpenseMachineContext = {
  hasCapital: boolean;
};

export const NEUTRAL_CONTEXT: ExpenseMachineContext = {
  hasCapital: false,
};

type GuardArgs = { context: ExpenseMachineContext; event: ExpenseEvent };

export const expenseGuards = {
  allOwnersResolved: ({ event }: GuardArgs) =>
    event.type === 'FLOW_STARTED' && event.allOwnersResolved,

  anyRejected: ({ event }: GuardArgs) =>
    event.type === 'ALL_APPROVALS_TERMINAL' && event.anyRejected,

  hasCapital: ({ event }: GuardArgs) =>
    event.type === 'ALL_APPROVALS_TERMINAL' && event.hasCapital,

  hasCapitalItems: ({ event }: GuardArgs) =>
    event.type === 'CAPITAL_REVIEW_SUBMITTED' && event.hasCapitalItems,
};
