import { withArchivedHouseholds } from "@/lib/household/archived";
import { closeHouseholdApplications, countOpenApplications, lockOpenApplications } from "@/lib/membership/archive";
import { type AuditActor, personActor, systemActor } from "@/lib/auditActor";
import { ENROLLED_PARTICIPANT } from "@/lib/person/filters";
import { ServiceError } from "@checkin/component-kit";
import type { TxClient } from "@/lib/db-client";

const notFound = () => new ServiceError(404, "Household not found");
const refuse = (message: string) => new ServiceError(409, message);

const UNFINISHED = { phase: { not: "FINISHED" as const } };
const LIVE_BUCKET = { archivedAt: null };

/** Why the household cannot be archived, or null. Runs under the application, membership and household locks. */
async function archiveRefusal(tx: TxClient, householdId: number, membership: { status: string } | null): Promise<string | null> {
    if (membership?.status === "DENIED") return "A denied household cannot be archived.";
    if (membership?.status === "ACTIVE") return "This household has a current Treehouse membership. Revoke it before archiving the household.";

    const members = { householdId };
    if (await tx.programParticipant.findFirst({ where: { person: members, program: UNFINISHED, ...ENROLLED_PARTICIPANT }, select: { personId: true } })) {
        return "Someone in this household is enrolled in a program that has not finished. Remove the enrollment before archiving the household.";
    }
    if (await tx.personRole.findFirst({ where: { person: members }, select: { personId: true } })) {
        return "Someone in this household holds a role. Remove their roles before archiving the household.";
    }
    const programRole =
        (await tx.programVolunteer.findFirst({ where: { person: members, program: UNFINISHED }, select: { personId: true } })) ??
        (await tx.program.findFirst({ where: { leadMentor: members, ...UNFINISHED }, select: { id: true } })) ??
        (await tx.programInstance.findFirst({ where: { leadMentor: members, ...UNFINISHED }, select: { id: true } }));
    if (programRole) {
        return "Someone in this household volunteers on or leads a program that has not finished. Remove them from the program before archiving the household.";
    }
    if (await tx.budgetOwner.findFirst({ where: { owner: members, ...LIVE_BUCKET }, select: { id: true } })) {
        return "Someone in this household owns a bucket. Name a new owner before archiving the household.";
    }
    if (await tx.budgetOwnerTreasurer.findFirst({ where: { person: members, budgetOwner: LIVE_BUCKET }, select: { personId: true } })) {
        return "Someone in this household is a treasurer of a bucket. Remove them as treasurer before archiving the household.";
    }
    if (await tx.trustedAdultReview.findFirst({ where: { householdId, status: { in: ["PENDING_BOARD_REVIEW", "PENDING_SUBJECT_ACTION"] } }, select: { id: true } })) {
        return "Can't archive: a trusted-adult review is pending for this household. Decide or withdraw it first.";
    }
    return null;
}

/**
 * Board "Archive household": refuses with the reason while anything still ties the
 * household to the organisation, otherwise closes its open applications (blocked ones
 * included, the rejection kept in `archivedFromStatus` and the audit row) and sets
 * `archivedAt`, in one transaction.
 */
export async function archiveHousehold(householdId: number, actorId: number) {
    const actor = personActor(actorId);
    return withArchivedHouseholds(async (tx) => {
        const household = await tx.household.findUnique({ where: { id: householdId }, select: { archivedAt: true } });
        if (!household) throw notFound();
        if (household.archivedAt) throw refuse("This household is already archived.");

        // Membership, household, then applications: the order lib/lockOrder.ts states.
        const found = await tx.orgMembership.findUnique({ where: { householdId }, select: { id: true } });
        const openApplications = found ? await lockOpenApplications(tx, found.id) : [];
        const [membership] = found
            ? await tx.$queryRaw<{ status: string }[]>`SELECT status FROM "OrgMembership" WHERE id = ${found.id} FOR UPDATE`
            : [null];

        // The Household row last: every guarded write takes it, after any membership lock.
        await tx.$queryRaw`SELECT id FROM "Household" WHERE id = ${householdId} FOR UPDATE`;

        const refusal = await archiveRefusal(tx, householdId, membership ?? null);
        if (refusal) throw refuse(refusal);
        // Every writer of an application holds the membership row, so none can open while this one is held.
        if (found && (await countOpenApplications(tx, found.id)) !== openApplications.length) {
            throw refuse("This household started an application while you were looking at it. Reload and try again.");
        }

        // Refuses while an open application holds a payment with no recorded refund.
        await closeHouseholdApplications(tx, openApplications, actor, "archive");
        const archivedAt = new Date();
        const { count } = await tx.household.updateMany({ where: { id: householdId, archivedAt: null }, data: { archivedAt } });
        if (count !== 1) throw refuse("This household changed while you were looking at it. Reload and try again.");
        await tx.auditLog.create({
            data: { ...actor, action: "EDIT", tableName: "Household", affectedEntityId: householdId, oldData: { archivedAt: null }, newData: { archivedAt } },
        });
        return tx.household.findUniqueOrThrow({ where: { id: householdId } });
    });
}

/** Clears `archivedAt` and records why. The caller holds the Household row. Closed applications stay closed. */
async function clearArchive(tx: TxClient, householdId: number, archivedAt: Date, actor: AuditActor, cause?: Record<string, string | number>) {
    const { count } = await tx.household.updateMany({ where: { id: householdId, archivedAt: { not: null } }, data: { archivedAt: null } });
    if (count !== 1) throw refuse("This household changed while you were looking at it. Reload and try again.");
    await tx.auditLog.create({
        data: { ...actor, action: "EDIT", tableName: "Household", affectedEntityId: householdId, oldData: { archivedAt }, newData: { archivedAt: null, ...cause } },
    });
}

/** Board "Unarchive household": clears `archivedAt`. */
export async function unarchiveHousehold(householdId: number, actorId: number) {
    return withArchivedHouseholds(async (tx) => {
        const household = await tx.household.findUnique({ where: { id: householdId }, select: { archivedAt: true } });
        if (!household) throw notFound();
        if (!household.archivedAt) throw refuse("This household is not archived.");

        await clearArchive(tx, householdId, household.archivedAt, personActor(actorId));
        return tx.household.findUniqueOrThrow({ where: { id: householdId } });
    });
}

/**
 * A member's sign-in unarchives their household, silently and with no notice to the
 * Board. A denied household stays archived. Returns whether it unarchived.
 */
export async function unarchiveOnSignIn(householdId: number, personId: number): Promise<boolean> {
    return withArchivedHouseholds(async (tx) => {
        // Membership, then household: the order lib/lockOrder.ts states.
        const [membership] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM "OrgMembership" WHERE "householdId" = ${householdId} FOR UPDATE`;
        if (membership?.status === "DENIED") return false;
        const [household] = await tx.$queryRaw<{ archivedAt: Date | null }[]>`SELECT "archivedAt" FROM "Household" WHERE id = ${householdId} FOR UPDATE`;
        if (!household?.archivedAt) return false;

        await clearArchive(tx, householdId, household.archivedAt, systemActor("system:sign-in"), { reason: "sign_in", signedInBy: personId });
        return true;
    });
}
