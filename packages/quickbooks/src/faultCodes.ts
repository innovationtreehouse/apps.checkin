import type { FailureKind } from "@checkin/component-kit";

/** What a known QuickBooks fault code means: a failure kind, or closed books, which ends as its own outcome. */
export type FaultCodeKind = "settings" | "data" | "closed";

export type FaultCodeTable = Readonly<Record<string, { readonly kind: FaultCodeKind; readonly description: string }>>;

/**
 * The QuickBooks fault codes the app knows, edited by PR with a test per entry.
 * A code not listed is sorted by its response's status.
 */
export const FAULT_CODES: FaultCodeTable = {
  "6210": { kind: "closed", description: "The entry is dated in a closed period." },
};

/** True when a refusal carries a closed-books code. */
export function isClosedPeriod(codes: readonly string[], table: FaultCodeTable = FAULT_CODES): boolean {
  return codes.some((c) => table[c]?.kind === "closed");
}

/**
 * A refused login is connection; 403 is too unless a listed code says otherwise.
 * A listed settings or data code decides any other 4xx; settings wins over data.
 */
export function faultKind(status: number, codes: readonly string[], table: FaultCodeTable = FAULT_CODES): FailureKind {
  if (status === 401) return "connection";
  if (status === 429 || status >= 500) return "system";
  const kinds = codes.map((c) => table[c]?.kind);
  if (kinds.includes("settings")) return "settings";
  if (kinds.includes("data")) return "data";
  return status === 403 ? "connection" : "data";
}
