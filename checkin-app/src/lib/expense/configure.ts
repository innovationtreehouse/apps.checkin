/**
 * Wire the expense library into checkin (#1272 §3/§6), called once at server boot from
 * instrumentation.ts. Binding touches no database: every port below reads lazily, inside a
 * request. The QuickBooks reader/writer, the catalog reader and the catalog event source stay
 * unbound (inert); they are later crossings.
 */
import { configureExpense } from "@inventory/expense";
import type { ExpensePrincipal, OwnerDirectory, SignoffDirectory } from "@inventory/expense";
import type { PersonRoleKind, Prisma } from "@/generated/prisma/client";
import { getOrg, sessionUser } from "@/lib/catalog/configure";

async function db() {
  return (await import("@/lib/prisma")).default;
}

/** The signed-in person with their finance roles; null for any session checkin refuses. */
async function getPrincipal(): Promise<ExpensePrincipal | null> {
  const user = await sessionUser();
  if (!user) return null;
  return { id: user.id, name: user.name ?? null, isFinance: user.isFinance === true, isBoard: user.isBoardMember === true };
}

const budgetOwners: OwnerDirectory = {
  async list() {
    return (await db()).budgetOwner.findMany({ select: { id: true, name: true, archivedAt: true }, orderBy: { name: "asc" } });
  },
};

/** A live person whose household is not DENIED: a denied household's roles grant nothing (assignParticipantClaims). */
async function eligibleSigner(): Promise<Prisma.PersonWhereInput> {
  const { LIVE_PERSON } = await import("@/lib/person/filters");
  return { ...LIVE_PERSON, NOT: { household: { orgMembership: { status: "DENIED" } } } };
}

async function roleHolders(role: PersonRoleKind): Promise<number[]> {
  const rows = await (await db()).personRole.findMany({ where: { role, person: await eligibleSigner() }, select: { personId: true } });
  return rows.map((r) => r.personId);
}

/** Approvers are derived, never stored: a program bucket's lead mentor and its program treasurers. */
const signoff: SignoffDirectory = {
  async bucketApprovers(bucketId) {
    const { orgMembershipStatusBlocksLogin } = await import("@/lib/orgMembership");
    const bucket = await (await db()).budgetOwner.findUnique({
      where: { id: bucketId },
      select: {
        programId: true,
        program: {
          select: {
            leadMentor: { select: { id: true, mergedIntoId: true, household: { select: { orgMembership: { select: { status: true } } } } } },
            volunteers: { where: { isTreasurer: true, person: await eligibleSigner() }, select: { personId: true } },
          },
        },
      },
    });
    if (!bucket) return { orgLevel: false, approvers: [] };
    if (bucket.programId === null || !bucket.program) return { orgLevel: true, approvers: [] };
    const lead = bucket.program.leadMentor;
    const leadEligible = lead && lead.mergedIntoId === null && !orgMembershipStatusBlocksLogin(lead.household?.orgMembership?.status);
    const approvers = [...(leadEligible ? [lead.id] : []), ...bucket.program.volunteers.map((v) => v.personId)];
    return { orgLevel: false, approvers: [...new Set(approvers)] };
  },

  async bucketsApprovedBy(personId) {
    const signer = await eligibleSigner();
    const rows = await (await db()).budgetOwner.findMany({
      where: {
        program: {
          OR: [
            { leadMentorId: personId, leadMentor: signer },
            { volunteers: { some: { personId, isTreasurer: true, person: signer } } },
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
    // Live members of every household holding one of these people (a merged-away person's
    // household still counts, so a tombstone id never narrows the conflict set).
    const members = await (await db()).person.findMany({
      where: { household: { householdMembers: { some: { id: { in: personIds } } } }, ...LIVE_PERSON },
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
