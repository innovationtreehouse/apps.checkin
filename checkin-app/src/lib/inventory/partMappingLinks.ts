/** The Part mapping receipt id for each receipt id, read off the receipt queue's `?receiptId=` filter. */
export async function receivedReceiptIds(receiptIds: readonly string[]): Promise<Record<string, number>> {
  if (receiptIds.length === 0) return {};
  const q = new URLSearchParams(receiptIds.map((id) => ["receiptId", id]));
  const res = await fetch(`/api/workflow-mapping/receipts?${q}`);
  if (!res.ok) throw new Error(`The Part mapping receipt lookup failed (HTTP ${res.status})`);
  const rows = (await res.json()) as Array<{ id: number; receiptId?: string }>;
  // A row without its receiptId means the viewer's response tier withholds it, so the links cannot be built.
  if (rows.some((r) => !r.receiptId)) throw new Error("The Part mapping receipt lookup returned rows without their receipt id");
  return Object.fromEntries(rows.map((r) => [r.receiptId, r.id]));
}
