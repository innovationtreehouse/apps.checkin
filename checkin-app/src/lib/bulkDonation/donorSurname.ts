// Household and surname reads for in-kind gifts. Loaded at boot by the bulk-donation wiring, so it
// imports nothing beyond the person model: no handler, auth or session code.
import type { DbClient } from "@/lib/db-client";
import { LIVE_PERSON } from "@/lib/person/filters";

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

/** Real merges are one hop; the cap stops a corrupt or cyclic chain from looping. */
const MAX_MERGE_HOPS = 5;

/**
 * Each id's surviving person: follows mergedIntoId, or the merge archive when the tombstone row
 * is gone. An id that resolves nowhere maps to itself.
 */
async function survivorsOf(db: DbClient, ids: number[]): Promise<Map<number, number>> {
  const current = new Map(ids.map((id) => [id, id]));
  for (let hop = 0; hop <= MAX_MERGE_HOPS; hop++) {
    const pending = [...new Set(current.values())];
    const rows = await db.person.findMany({ where: { id: { in: pending } }, select: { id: true, mergedIntoId: true } });
    const missing = pending.filter((id) => !rows.some((r) => r.id === id));
    const archived = missing.length === 0 ? [] : await db.personMerge.findMany({ where: { fromId: { in: missing } }, select: { fromId: true, toId: true } });
    const next = new Map([...rows.flatMap((r) => (r.mergedIntoId === null ? [] : [[r.id, r.mergedIntoId] as const])), ...archived.map((a) => [a.fromId, a.toId] as const)]);
    if (next.size === 0) break;
    for (const [id, at] of current) current.set(id, next.get(at) ?? at);
  }
  return current;
}

/**
 * Each person's household as live members, the person and their survivor included. A merged
 * person is read through the person they were merged into. A person with no household is a
 * household of one.
 */
async function householdsByPerson(db: DbClient, personIds: number[]): Promise<Map<number, Member[]>> {
  const ids = [...new Set(personIds)];
  if (ids.length === 0) return new Map();
  const survivors = await survivorsOf(db, ids);
  const survivorIds = [...new Set(survivors.values())];
  const people = await db.person.findMany({ where: { id: { in: survivorIds } }, select: { id: true, name: true, householdId: true } });
  const householdIds = [...new Set(people.map((p) => p.householdId).filter((h): h is number => h !== null))];
  const members =
    householdIds.length === 0
      ? []
      : await db.person.findMany({ where: { householdId: { in: householdIds }, ...LIVE_PERSON }, select: { id: true, name: true, householdId: true } });
  return new Map(
    ids.map((id) => {
      const person = people.find((p) => p.id === survivors.get(id));
      const mates = person?.householdId == null ? [] : members.filter((m) => m.householdId === person.householdId);
      return [id, person && !mates.some((m) => m.id === person.id) ? [person, ...mates] : mates];
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
