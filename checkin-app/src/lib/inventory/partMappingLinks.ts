/** The Part mapping receipt id for each receipt id, read off the receipt queue's `?receiptId=` filter. */
export async function receivedReceiptIds(receiptIds: readonly string[]): Promise<Record<string, number>> {
  if (receiptIds.length === 0) return {};
  const q = new URLSearchParams(receiptIds.map((id) => ["receiptId", id]));
  const res = await fetch(`/api/workflow-mapping/receipts?${q}`);
  if (!res.ok) throw new Error(`The Part mapping receipt lookup failed (HTTP ${res.status})`);
  const rows = (await res.json()) as Array<{ id: number; receiptId?: string }>;
  return Object.fromEntries(rows.flatMap((r) => (r.receiptId ? [[r.receiptId, r.id]] : [])));
}
