import { withArchivedHouseholds } from "@/lib/household/archived";
import { closeForRestore, lockOpenApplications } from "@/lib/membership/archive";
import { personActor } from "@/lib/auditActor";
import { ENROLLED_PARTICIPANT } from "@/lib/person/filters";
import { ServiceError } from "@checkin/component-kit";
import type { TxClient } from "@/lib/db-client";

const notFound = () => new ServiceError(404, "Household not found");
const refuse = (message: string) => new ServiceError(409, message);

const UNFINISHED = { phase: { not: "FINISHED" as const } };

/** Why the household cannot be archived, or null. Runs under the membership and application locks. */
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

        // Applications before the membership row, the order restore, payment and reset lock in.
        const found = await tx.orgMembership.findUnique({ where: { householdId }, select: { id: true } });
        const openApplications = found ? await lockOpenApplications(tx, found.id) : [];
        const [membership] = found
            ? await tx.$queryRaw<{ status: string }[]>`SELECT status FROM "OrgMembership" WHERE id = ${found.id} FOR UPDATE`
            : [null];

        const refusal = await archiveRefusal(tx, householdId, membership ?? null);
        if (refusal) throw refuse(refusal);

        // Refuses while an open application holds a payment with no recorded refund.
        await closeForRestore(tx, openApplications, actor, "archive");
        const archivedAt = new Date();
        const { count } = await tx.household.updateMany({ where: { id: householdId, archivedAt: null }, data: { archivedAt } });
        if (count !== 1) throw refuse("This household changed while you were looking at it. Reload and try again.");
        await tx.auditLog.create({
            data: { ...actor, action: "EDIT", tableName: "Household", affectedEntityId: householdId, oldData: { archivedAt: null }, newData: { archivedAt } },
        });
        return tx.household.findUniqueOrThrow({ where: { id: householdId } });
    });
}

/** Board "Unarchive household": clears `archivedAt`. Closed applications stay closed. */
export async function unarchiveHousehold(householdId: number, actorId: number) {
    return withArchivedHouseholds(async (tx) => {
        const household = await tx.household.findUnique({ where: { id: householdId }, select: { archivedAt: true } });
        if (!household) throw notFound();
        if (!household.archivedAt) throw refuse("This household is not archived.");

        const { count } = await tx.household.updateMany({ where: { id: householdId, archivedAt: { not: null } }, data: { archivedAt: null } });
        if (count !== 1) throw refuse("This household changed while you were looking at it. Reload and try again.");
        await tx.auditLog.create({
            data: { ...personActor(actorId), action: "EDIT", tableName: "Household", affectedEntityId: householdId, oldData: { archivedAt: household.archivedAt }, newData: { archivedAt: null } },
        });
        return tx.household.findUniqueOrThrow({ where: { id: householdId } });
    });
}
