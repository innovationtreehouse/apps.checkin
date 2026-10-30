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

/** Live members of every household holding one of these people; a merged-away person's household still counts. */
export async function householdOf(personIds: number[]): Promise<number[]> {
  if (personIds.length === 0) return [];
  const [{ default: prisma }, { LIVE_PERSON }] = await Promise.all([import("@/lib/prisma"), import("@/lib/person/filters")]);
  const members = await prisma.person.findMany({
    where: { household: { householdMembers: { some: { id: { in: personIds } } } }, ...LIVE_PERSON },
    select: { id: true },
  });
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
