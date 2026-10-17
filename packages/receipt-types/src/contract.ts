/**
 * Cross-library contract versioning. The sender (workflow-mapping) and the
 * receivers (expense, local-inventory) import from here so the version rule
 * cannot drift apart.
 */

/**
 * Semantic version of the receipt/inventory cross-service contract. Bump the
 * MAJOR when a backward-incompatible change is made to CompletedReceiptSchema
 * or ResolvedInventoryDeltaSchema; bump MINOR for additive, backward-compatible
 * changes. Receivers should reject payloads whose MAJOR differs from their own.
 */
export const RECEIPT_CONTRACT_VERSION = "1.1.0";

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
