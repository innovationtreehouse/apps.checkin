// Household and surname reads for in-kind gifts. Loaded at boot by the bulk-donation wiring, so it
// imports nothing beyond the person model: no handler, auth or session code.
import type { DbClient } from "@/lib/db-client";

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);

/** The last word of a name that is not a generational suffix, lowercased with accents removed; "" when it has none. */
export function surname(name: string): string {
  const words = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  return words.filter((w) => !SUFFIXES.has(w)).at(-1) ?? "";
}

interface Member {
  id: number;
  name: string;
}

/** Each id's surviving person: itself, or the merge archive's survivor when its row is gone. */
async function survivorsOf(db: DbClient, ids: number[]): Promise<Map<number, number>> {
  const rows = await db.person.findMany({ where: { id: { in: ids } }, select: { id: true } });
  const missing = ids.filter((id) => !rows.some((r) => r.id === id));
  const archived = missing.length === 0 ? [] : await db.personMerge.findMany({ where: { fromId: { in: missing } }, select: { fromId: true, toId: true } });
  const next = new Map(archived.map((a) => [a.fromId, a.toId] as const));
  return new Map(ids.map((id) => [id, next.get(id) ?? id]));
}

/**
 * Each person's household as live members, the person included. A merged-away id reads as its
 * survivor's household. A person with no household is a household of one.
 */
async function householdsByPerson(db: DbClient, personIds: number[]): Promise<Map<number, Member[]>> {
  const ids = [...new Set(personIds)];
  if (ids.length === 0) return new Map();
  const survivors = await survivorsOf(db, ids);
  const people = await db.person.findMany({ where: { id: { in: [...new Set([...ids, ...survivors.values()])] } }, select: { id: true, name: true, householdId: true } });
  const householdIds = [...new Set(people.map((p) => p.householdId).filter((h): h is number => h !== null))];
  const members =
    householdIds.length === 0
      ? []
      : await db.person.findMany({ where: { householdId: { in: householdIds } }, select: { id: true, name: true, householdId: true } });
  return new Map(
    ids.map((id) => {
      const selves = people.filter((p) => p.id === id || p.id === survivors.get(id));
      const homes = new Set(selves.map((p) => p.householdId).filter((h): h is number => h !== null));
      const all = [...selves, ...members.filter((m) => m.householdId !== null && homes.has(m.householdId))];
      return [id, [...new Map(all.map((m) => [m.id, m])).values()]];
    }),
  );
}

/** Each person's household member ids, the person included. */
export async function householdMembersOf(db: DbClient, personIds: number[]): Promise<Map<number, number[]>> {
  const households = await householdsByPerson(db, personIds);
  return new Map(personIds.map((id) => [id, [...new Set([id, ...(households.get(id) ?? []).map((m) => m.id)])]]));
}

/** For each check, whether anyone in the person's household, the person included, has the donor's surname. */
export async function householdsSharingSurname(db: DbClient, checks: { personId: number; lastName: string }[]): Promise<boolean[]> {
  const households = await householdsByPerson(db, checks.map((c) => c.personId));
  return checks.map(({ personId, lastName }) => {
    const donorSurname = surname(lastName);
    return donorSurname !== "" && (households.get(personId) ?? []).some((m) => surname(m.name) === donorSurname);
  });
}
