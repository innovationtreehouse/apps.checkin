// The one place an expense's stored person ids become people. A merge cannot rewrite ids in this
// database, so a read that skips this leaves the survivor unconflicted on their own spending.
import type { Db } from "../db";
import { getExpenseRuntime } from "../runtime";

/** The live person each id names, deduplicated for the host; null for an id that names nobody live. */
export async function liveIds(personIds: number[]): Promise<Map<number, number | null>> {
  if (personIds.length === 0) return new Map();
  return getExpenseRuntime().signoff.liveIds([...new Set(personIds)]);
}

/** The live person the id names, or the id as stored when it names nobody live. */
export async function liveIdOf(personId: number): Promise<number> {
  return (await liveIds([personId])).get(personId) ?? personId;
}

type Parties = { submitterId?: number; reimburseePersonId?: number | null };

/**
 * The rows with each party naming the live person. An id naming nobody live stays as stored: it
 * matches no caller, and the conflict check and sign-off facts refuse it by asking `liveIds` themselves.
 */
export async function withLiveParties<T extends Parties>(rows: T[]): Promise<T[]> {
  const live = await liveIds(rows.flatMap((row) => [row.submitterId ?? [], row.reimburseePersonId ?? []].flat()));
  const current = (id: number) => live.get(id) ?? id;
  return rows.map((row) => ({
    ...row,
    ...(row.submitterId == null ? {} : { submitterId: current(row.submitterId) }),
    ...(row.reimburseePersonId == null ? {} : { reimburseePersonId: current(row.reimburseePersonId) }),
  }));
}

/** One row through `withLiveParties`; no row stays none. */
export async function withLiveParty<T extends Parties>(row: T | null): Promise<T | null> {
  return row && (await withLiveParties([row]))[0];
}

/** Every id a row may hold for the person this id names; just the id when it names nobody live. */
export async function storedIdsFor(personId: number): Promise<number[]> {
  const live = (await liveIds([personId])).get(personId);
  return live == null ? [personId] : getExpenseRuntime().signoff.storedIdsOf(live);
}

/** The person's QuickBooks Vendor link. One merged from two linked records has two: their live record's wins. */
export async function reimburseeVendorLink(client: Db, orgId: string, personId: number) {
  const [live, ids] = await Promise.all([liveIdOf(personId), storedIdsFor(personId)]);
  const links = await client.expenseReimburseeVendor.findMany({ where: { orgId, reimburseePersonId: { in: ids } }, orderBy: { id: "asc" } });
  return links.find((link) => link.reimburseePersonId === live) ?? links[0] ?? null;
}
