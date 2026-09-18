/**
 * The org-event (S5) contract now lives in the shared `@inventory/receipt-types`
 * package so the producer (this app) and the consumers (workflow-mapping,
 * expense, local-inventory) cannot drift. This module re-exports it to keep
 * existing `@/types/orgEvents` import paths working.
 */
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
} from "@inventory/receipt-types";
export type { OrgEventPayload, OrgEventType } from "@inventory/receipt-types";
