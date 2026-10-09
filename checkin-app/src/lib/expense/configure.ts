/**
 * Wire the expense library into checkin (#1272 §3/§6), called once at server boot from
 * instrumentation.ts. Binding touches no database: every port below reads lazily, inside a
 * request. The QuickBooks reader/writer, the catalog reader and the catalog event source stay
 * unbound (inert); they are later crossings.
 */
import { configureExpense } from "@inventory/expense";
import type { ExpensePrincipal, OwnerDirectory, SignoffDirectory } from "@inventory/expense";
import type { PersonRoleKind } from "@/generated/prisma/client";
import { getOrg } from "@/lib/catalog/configure";

async function db() {
  return (await import("@/lib/prisma")).default;
}

/** The signed-in person with their finance roles; null unless the session carries an integer id. */
async function getPrincipal(): Promise<ExpensePrincipal | null> {
  // Lazy: importing auth-options at boot would crash a Google-credless boot.
  const [{ getServerSession }, { authOptions }] = await Promise.all([
    import("next-auth"),
    import("@/lib/auth-options"),
  ]);
  const user = (await getServerSession(authOptions))?.user;
  if (!user || typeof user.id !== "number") return null;
  return { id: user.id, name: user.name ?? null, isFinance: user.isFinance === true, isBoard: user.isBoardMember === true };
}

const budgetOwners: OwnerDirectory = {
  async list() {
    return (await db()).budgetOwner.findMany({ select: { id: true, name: true, archivedAt: true }, orderBy: { name: "asc" } });
  },
};

async function roleHolders(role: PersonRoleKind): Promise<number[]> {
  const { LIVE_PERSON } = await import("@/lib/person/filters");
  const rows = await (await db()).personRole.findMany({ where: { role, person: LIVE_PERSON }, select: { personId: true } });
  return rows.map((r) => r.personId);
}

/** Approvers are derived, never stored: a program bucket's lead mentor and its program treasurers. */
const signoff: SignoffDirectory = {
  async bucketApprovers(bucketId) {
    const { LIVE_PERSON } = await import("@/lib/person/filters");
    const bucket = await (await db()).budgetOwner.findUnique({
      where: { id: bucketId },
      select: {
        programId: true,
        program: {
          select: {
            leadMentor: { select: { id: true, mergedIntoId: true } },
            volunteers: { where: { isTreasurer: true, person: LIVE_PERSON }, select: { personId: true } },
          },
        },
      },
    });
    if (!bucket) return { orgLevel: false, approvers: [] };
    if (bucket.programId === null || !bucket.program) return { orgLevel: true, approvers: [] };
    const lead = bucket.program.leadMentor;
    const approvers = [...(lead && lead.mergedIntoId === null ? [lead.id] : []), ...bucket.program.volunteers.map((v) => v.personId)];
    return { orgLevel: false, approvers: [...new Set(approvers)] };
  },

  async bucketsApprovedBy(personId) {
    const rows = await (await db()).budgetOwner.findMany({
      where: {
        program: {
          OR: [
            { leadMentorId: personId, leadMentor: { mergedIntoId: null } },
            { volunteers: { some: { personId, isTreasurer: true, person: { mergedIntoId: null } } } },
          ],
        },
      },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  },

  financeHolders: () => roleHolders("FINANCE"),
  boardMembers: () => roleHolders("BOARD"),

  async householdOf(personIds) {
    if (personIds.length === 0) return [];
    const { LIVE_PERSON } = await import("@/lib/person/filters");
    const prisma = await db();
    const households = await prisma.person.findMany({ where: { id: { in: personIds } }, select: { householdId: true } });
    const members = await prisma.person.findMany({
      where: { householdId: { in: households.map((h) => h.householdId) }, ...LIVE_PERSON },
      select: { id: true },
    });
    return members.map((m) => m.id);
  },

  async personExists(personId) {
    const { LIVE_PERSON } = await import("@/lib/person/filters");
    return (await (await db()).person.count({ where: { id: personId, ...LIVE_PERSON } })) > 0;
  },

  async isOrgMember(personId) {
    const { isActiveOrgMember } = await import("@/lib/orgMembership");
    return isActiveOrgMember(personId);
  },
};

export function configureRuntime(): void {
  configureExpense({ org: getOrg, auth: { getPrincipal }, budgetOwners, signoff });
}
