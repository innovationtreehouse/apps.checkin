import { z } from "zod";

/**
 * S5 — global-catalog → (workflow-mapping / expense / local-inventory) org-event
 * contract. Single source of truth for the asynchronous provisional-resolution
 * feed. The PRODUCER (global-catalog `emitOrgEvent`) parses a payload against
 * `orgEventPayloadSchema` before persisting; every CONSUMER parses the polled
 * payload against the SAME schema before acting. Neither side may redeclare it.
 *
 * Storage note: the org_events table stores `eventType` in its own column and
 * the remaining fields as the JSON `payload`. So a stored/polled payload does
 * NOT carry `eventType` — consumers must reattach it before parsing. Use
 * `parseOrgEvent(eventType, rawPayload)` which does exactly that.
 */

export const itemReferenceProposalApprovedSchema = z.object({
  eventType: z.literal("item_reference_proposal_approved"),
  version: z.literal(1),
  proposalId: z.number(),
  gtin13: z.string(),
  partNumber: z.string().nullable(),
  manufacturer: z.string().nullable(),
  retailer: z.string().nullable(),
});

export const itemReferenceProposalSupersededSchema = z.object({
  eventType: z.literal("item_reference_proposal_superseded"),
  version: z.literal(1),
  proposalId: z.number(),
  supersededByProposalId: z.number(),
});

export const itemReferenceProposalRejectedSchema = z.object({
  eventType: z.literal("item_reference_proposal_rejected"),
  version: z.literal(1),
  proposalId: z.number(),
  gtin13: z.string(),
  rejectionReason: z.string().nullable(),
});

export const conversionChallengeAcceptedSchema = z.object({
  eventType: z.literal("conversion_challenge_accepted"),
  version: z.literal(1),
  challengeId: z.number(),
  itemReferenceId: z.number(),
  // Conversion factors are integers system-wide (inventory units per
  // receipt-line unit) — no fractional packs, so quantities never round.
  previousFactor: z.number().int().positive(),
  acceptedFactor: z.number().int().positive(),
  conversionVersion: z.number().int().positive(),
});

export const conversionChallengeRejectedSchema = z.object({
  eventType: z.literal("conversion_challenge_rejected"),
  version: z.literal(1),
  challengeId: z.number(),
  itemReferenceId: z.number(),
  proposedFactor: z.number().int().positive(),
});

export const provisionalApprovedSchema = z.object({
  eventType: z.literal("provisional_approved"),
  version: z.literal(1),
  provisionalGtin13: z.string(),
  realGtin13: z.string(),
  name: z.string(),
  // The newly-created real item's canonical conversion factor (= the
  // human-entered factor on the provisional proposal). Carried so the
  // consumer can stamp units. Defaults to 1 (forward-only rollout).
  conversionFactor: z.number().int().positive().default(1),
  conversionVersion: z.number().int().positive().default(1),
});

export const provisionalRejectedSchema = z.object({
  eventType: z.literal("provisional_rejected"),
  version: z.literal(1),
  provisionalGtin13: z.string(),
  rejectionReason: z.string().nullable(),
});

export const provisionalMappedToExistingSchema = z.object({
  eventType: z.literal("provisional_mapped_to_existing"),
  version: z.literal(1),
  provisionalGtin13: z.string(),
  realGtin13: z.string(),
  // The EXISTING real item's canonical conversion factor at map time. The
  // consumer compares this against the factor its provisional stock was
  // counted under: if they differ the quantities are not directly summable,
  // so it parks a uom_mismatch conflict instead of blind-summing.
  // Defaults to 1 (forward-only rollout).
  conversionFactor: z.number().int().positive().default(1),
  conversionVersion: z.number().int().positive().default(1),
});

export const orgEventPayloadSchema = z.discriminatedUnion("eventType", [
  itemReferenceProposalApprovedSchema,
  itemReferenceProposalSupersededSchema,
  itemReferenceProposalRejectedSchema,
  conversionChallengeAcceptedSchema,
  conversionChallengeRejectedSchema,
  provisionalApprovedSchema,
  provisionalRejectedSchema,
  provisionalMappedToExistingSchema,
]);

export type OrgEventPayload = z.infer<typeof orgEventPayloadSchema>;
export type OrgEventType = OrgEventPayload["eventType"];

/** Every event type the contract currently defines. */
export const ORG_EVENT_TYPES = [
  "item_reference_proposal_approved",
  "item_reference_proposal_superseded",
  "item_reference_proposal_rejected",
  "conversion_challenge_accepted",
  "conversion_challenge_rejected",
  "provisional_approved",
  "provisional_rejected",
  "provisional_mapped_to_existing",
] as const;

/**
 * Reattach the envelope `eventType` to a stored/polled payload and parse it
 * against the discriminated union. Throws (ZodError) when the eventType is
 * unknown, the version is unsupported, or a required field is missing — the
 * caller's poller then routes the event to its failed/quarantine path. The
 * returned value is the NARROWED member, so a consumer's `switch (ev.eventType)`
 * gets fully-typed fields with no manual null checks.
 */
export function parseOrgEvent(eventType: string, rawPayload: unknown): OrgEventPayload {
  const merged = { ...(rawPayload as Record<string, unknown>), eventType };
  return orgEventPayloadSchema.parse(merged);
}
