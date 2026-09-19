/**
 * Cross-service contract governance primitives.
 *
 * These constants and helpers are the single source of truth for how services
 * version their payloads and deduplicate side-effecting pushes. Both the sender
 * (workflow-mapping-app) and the receivers (expense-app, local-inventory)
 * import from here so the wire conventions cannot drift apart.
 */

/**
 * Semantic version of the receipt/inventory cross-service contract. Bump the
 * MAJOR when a backward-incompatible change is made to CompletedReceiptSchema
 * or ResolvedInventoryDeltaSchema; bump MINOR for additive, backward-compatible
 * changes. Receivers should reject payloads whose MAJOR differs from their own.
 */
export const RECEIPT_CONTRACT_VERSION = "1.0.0";

/** Header carrying RECEIPT_CONTRACT_VERSION on every cross-service request. */
export const SCHEMA_VERSION_HEADER = "X-Schema-Version";

/**
 * Header carrying a stable idempotency key on every side-effecting push.
 * Receivers MUST treat two requests bearing the same key as the same logical
 * operation and apply the effect at most once.
 */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/** Extract the MAJOR component of a semver string (e.g. "1.4.2" -> 1). */
export function majorVersion(version: string): number {
  return Number.parseInt(version.split(".")[0] ?? "", 10);
}

/**
 * True when `incoming` is compatible with the contract version this service
 * was built against — i.e. the MAJOR versions match. A missing/blank incoming
 * version is treated as compatible (legacy senders predate versioning).
 */
export function isContractVersionCompatible(
  incoming: string | null | undefined,
  current: string = RECEIPT_CONTRACT_VERSION,
): boolean {
  if (!incoming) return true;
  const a = majorVersion(incoming);
  const b = majorVersion(current);
  return Number.isFinite(a) && a === b;
}

/**
 * Idempotency key for pushing a receipt's resolved expense to expense-app.
 * Stable across retries and duplicate deliveries of the SAME receipt apply, so
 * a replay (operator retry, double-click, duplicate SQS message) is deduped by
 * the receiver instead of producing a second expense record.
 */
export function expenseApplyIdempotencyKey(receiptId: string): string {
  return `expense-apply:${receiptId}`;
}

/**
 * Idempotency key for pushing a receipt's resolved inventory delta to
 * local-inventory. Stable across retries and duplicate deliveries of the SAME
 * receipt apply (see expenseApplyIdempotencyKey).
 */
export function inventoryApplyIdempotencyKey(receiptId: string): string {
  return `inventory-apply:${receiptId}`;
}
