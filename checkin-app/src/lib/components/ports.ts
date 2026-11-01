/**
 * Host port adapters more than one component binds. Each loads its dependency on first use,
 * so binding at boot stays DB-free.
 */
import type { BooksMap } from "@checkin/quickbooks";

export const budgetOwners = {
  async list() {
    const { default: prisma } = await import("@/lib/prisma");
    return prisma.budgetOwner.findMany({ select: { id: true, name: true, archivedAt: true, quickBooksClassId: true }, orderBy: { name: "asc" } });
  },
};

/** Members of every household holding one of these people. */
export async function householdOf(personIds: number[]): Promise<number[]> {
  if (personIds.length === 0) return [];
  const { default: prisma } = await import("@/lib/prisma");
  const members = await prisma.person.findMany({
    where: { household: { householdMembers: { some: { id: { in: personIds } } } } },
    select: { id: true },
  });
  return members.map((m) => m.id);
}

/** Each person's household as householdOf([id]) reads it, in two queries for any number of people. */
export async function householdsOf(personIds: number[]): Promise<Map<number, number[]>> {
  if (personIds.length === 0) return new Map();
  const { default: prisma } = await import("@/lib/prisma");
  const people = await prisma.person.findMany({ where: { id: { in: personIds } }, select: { id: true, householdId: true } });
  const members = await prisma.person.findMany({
    where: { householdId: { in: [...new Set(people.map((p) => p.householdId))] } },
    select: { id: true, householdId: true },
  });
  return new Map(people.map((p) => [p.id, members.filter((m) => m.householdId === p.householdId).map((m) => m.id)]));
}

/** Everyone in the person's household, merged-away people included; none for an unknown id. */
export async function householdIds(personId: number): Promise<number[]> {
  const { default: prisma } = await import("@/lib/prisma");
  const members = await prisma.person.findMany({ where: { household: { householdMembers: { some: { id: personId } } } }, select: { id: true } });
  return members.map((m) => m.id);
}

/** Checkin's one guarded QuickBooks client; null while the guard keeps it off. */
export async function quickBooks() {
  return (await import("@/lib/quickbooks/client")).getQuickBooks();
}

export const booksMap: BooksMap = {
  async accounts() {
    return (await import("@/lib/finance/booksMap")).booksMap.accounts();
  },
  async classes() {
    return (await import("@/lib/finance/booksMap")).booksMap.classes();
  },
};
