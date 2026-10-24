// Public surface of the @checkin/expense library. Pages and nav are the ./pages/* and ./nav
// subpath exports.
export * from "./contract";
export * from "./runtime";
export * from "./db";
export * from "./db/schema";

export * from "./lib/caller";
export * from "./lib/capital-register";
export * from "./lib/expense-constants";
export * from "./lib/expense-rules";
export * from "./lib/flags";
export * from "./lib/signoff";
export { allocateAmount, checkAndProcessExpense, recoverStrandedQbExpenses } from "./lib/expense-qb-processor";
export { drainExpenseOutbox, postExpenseToQb } from "./lib/expense-qb-poster";
export { checkQbDrift } from "./lib/expense-qb-drift";
export { isLegalTransition, legalEventTypes, isTerminalState } from "./workflows/expense.invariants";

export * from "./repositories/expense";
export * from "./repositories/org";
export * from "./repositories/partOwner";
export * from "./repositories/provisionalItemMap";

export * from "./services/approvalService";
export * from "./services/badgeCounts";
export * from "./services/capitalService";
export * from "./services/catalogEventConsumer";
export * from "./services/flagService";
export * from "./services/holdService";
export * from "./services/intakeService";
export * from "./services/provisionalItemMapService";
export * from "./services/qbMatchService";
export * from "./services/reimbursementStatus";
export * from "./services/reimburseeVendorService";
export * from "./services/settingsService";
export * from "./services/signoffService";
export * from "./services/submitterSeatService";
export { expenseStateCounts, EXPENSE_STATES, type ExpenseStateCount } from "./services/stateCounts";
export * from "./services/sweeps";

export * as routes from "./routes";
