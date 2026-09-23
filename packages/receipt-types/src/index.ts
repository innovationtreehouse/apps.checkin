export type ReceiptState =
  | "uploaded"
  | "auto_upload"
  | "ocr_failed"
  | "duplicate_flagged"
  | "validation_failed"
  | "submitter_review"
  | "financial_review"
  | "flow_error"
  | "discarded"
  | "rejected"
  | "receipt_finalized";

export type LineItemApprovalStatus =
  | "pending"
  | "approved"
  | "exception_raised"
  | "unknown"
  | "finance_assigned"
  | "rejected";

export type RecognitionStatus =
  | "unrecognized"
  | "recognized"
  | "provisional"
  | "non_inventory";

export type UsageBehavior =
  | "Single Use"
  | "Short Life Consumable"
  | "Long Life Consumable"
  | "Durable";

export { ResolvedInventoryDeltaSchema, ResolvedInventoryDeltaLineItemSchema } from "./resolved-inventory-delta";
export type { ResolvedInventoryDelta, ResolvedInventoryDeltaLineItem } from "./resolved-inventory-delta";

export { CompletedReceiptSchema, CompletedReceiptLineItemSchema } from "./completed-receipt";
export type { CompletedReceipt, CompletedReceiptLineItem } from "./completed-receipt";

export {
  RECEIPT_CONTRACT_VERSION,
  SCHEMA_VERSION_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  majorVersion,
  isContractVersionCompatible,
  expenseApplyIdempotencyKey,
  inventoryApplyIdempotencyKey,
} from "./contract";

// S5 — global-catalog → consumers org-event contract
export {
  orgEventPayloadSchema,
  parseOrgEvent,
  ORG_EVENT_TYPES,
  itemReferenceProposalApprovedSchema,
  itemReferenceProposalSupersededSchema,
  itemReferenceProposalRejectedSchema,
  conversionChallengeAcceptedSchema,
  conversionChallengeRejectedSchema,
  provisionalApprovedSchema,
  provisionalRejectedSchema,
  provisionalMappedToExistingSchema,
} from "./org-events";
export type { OrgEventPayload, OrgEventType } from "./org-events";

// S4 — workflow-mapping → global-catalog submission contract
export {
  catalogLookupEntrySchema,
  catalogItemsLookupSchema,
  catalogCheckReferencesSchema,
  catalogItemReferenceProposalSchema,
  catalogProvisionalItemProposalSchema,
  catalogReferenceConflictSchema,
} from "./catalog-submissions";
export type {
  CatalogItemsLookup,
  CatalogCheckReferences,
  CatalogItemReferenceProposal,
  CatalogProvisionalItemProposal,
  CatalogReferenceConflict,
} from "./catalog-submissions";
