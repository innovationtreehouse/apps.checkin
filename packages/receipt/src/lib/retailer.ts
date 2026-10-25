/** A retailer name as duplicate detection compares it: case-folded, trimmed, inner whitespace collapsed. */
export function retailerKey(retailer: string | null): string | null {
  return retailer === null ? null : retailer.trim().replace(/\s+/g, " ").toLowerCase();
}
