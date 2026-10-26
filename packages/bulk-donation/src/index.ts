// Public surface of the @checkin/bulk-donation library: domain, ports and route factories;
// screens and nav are the ./pages/* and ./nav exports.
export * from "./contract";
export * from "./runtime";
export * from "./inKind";
export { db, getPrisma, isUniqueConstraintError, type DbOrTx } from "./db";
export type {
  UploadedFile,
  Transaction,
  TransactionCommentRule,
  AccountMap,
  DisbursementHold,
  DisbursementEvent,
  DisbursementSnapshot,
  WorkflowEvent,
  DonationQbMatchExclusion,
  ManualInKindDonation,
  ManualInKindDonationLine,
  InKindDonationLine,
  InKindBooking,
} from "./generated/prisma/client";
export * from "./lib/account-map-lookup";
export * from "./lib/csv-parser";
export * from "./lib/disbursement-processor";
export * from "./lib/domain-rules";
export * from "./lib/qb-match";
export * from "./lib/qb-poster";
export * from "./lib/in-kind-poster";
export { recordEvent, recordDonorDataRead, type EntityType, type WorkflowEventInput, type DonorReadContext } from "./repositories/audit";
export { accountMapService } from "./services/accountMapService";
export { commentRuleService } from "./services/commentRuleService";
export { disbursementService } from "./services/disbursementService";
export { inKindService, type InKindMoney, type InKindMoneyLine, type SettleKind } from "./services/inKindService";
export {
  inKindAcceptService,
  InKindDecisionInputSchema,
  type InKindDecisionInput,
  type InKindOutcome,
  type InKindSource,
  type WaitingOn,
  spreadToTotal,
} from "./services/inKindAcceptService";
export {
  manualInKindService,
  ManualInKindInputSchema,
  MAX_IN_KIND_LINE_QUANTITY,
  MAX_IN_KIND_LINE_VALUE_CENTS,
  MAX_IN_KIND_LINES,
  MAX_IN_KIND_TOTAL_CENTS,
  type ManualInKindInput,
} from "./services/manualInKindService";
export { getNavCounts, type DonationNavCounts } from "./services/navCountsService";
export { transactionService } from "./services/transactionService";
export { uploadedFileService } from "./services/uploadedFileService";
export { disbursementMachine, STATES } from "./workflows/disbursement.machine";
export { sendDisbursementEvent, type AuditContext } from "./workflows/disbursement.actor";
export { WorkflowTransitionError } from "@checkin/workflows";
export * as routes from "./routes";
