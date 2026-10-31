/**
 * The org-event contract lives in the shared `@checkin/receipt-types` package so
 * the producer (this app) and the consumers (workflow-mapping, expense,
 * local-inventory) cannot drift. This module re-exports it for this library's imports.
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
} from "@checkin/receipt-types";
export type { OrgEventPayload, OrgEventType } from "@checkin/receipt-types";
