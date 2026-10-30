import type { DbClient, TxClient } from "@/lib/db-client";
import type { AuditActor } from "@/lib/auditActor";
import { fromWhere } from "@/lib/membership/lifecycle";

/**
 * The Key Volunteer Agreement (KVA) process rows: which version is current,
 * whether a person has signed it, and opening or closing a person's agreement.
 * Database-only, so `lib/roles.ts` can call it inside a role write. The signing
 * flow and the version bump live in `keyVolunteer.ts`.
 *
 * Rules: docs/rules/membership.md, "Key Volunteers".
 */

export const KVA_KIND = "KEY_VOLUNTEER_AGREEMENT" as const;

/** The agreement version the Board has marked current. */
export async function currentKvaVersion(db: DbClient): Promise<number> {
    const settings = await db.boardSettings.findUnique({ where: { id: 1 }, select: { keyVolunteerAgreementVersion: true } });
    return settings?.keyVolunteerAgreementVersion ?? 1;
}

/** True when the person's signed agreements include one at the current version. */
export async function hasSignedCurrentKva(db: DbClient, personId: number): Promise<boolean> {
    const version = await currentKvaVersion(db);
    const signed = await db.orgMembershipProcess.findFirst({
        where: { kind: KVA_KIND, subjectPersonId: personId, status: "ACTIVE", agreementVersion: { gte: version } },
        select: { id: true },
    });
    return signed !== null;
}

/** The person's open, unsigned agreement, newest first. */
export function findOpenKva(db: DbClient, personId: number) {
    return db.orgMembershipProcess.findFirst({
        where: { kind: KVA_KIND, subjectPersonId: personId, ...fromWhere("PENDING_EXTERNAL_ACTION") },
        orderBy: { id: "desc" },
    });
}

/**
 * Opens an agreement at the current version unless the person already has one
 * open or one signed at the current version. Creates no Zoho request: that waits
 * for the person's first click on "Sign", because each request costs money.
 */
export async function openKvaIfNeeded(tx: TxClient, personId: number, actor: AuditActor) {
    if (await findOpenKva(tx, personId)) return null;
    if (await hasSignedCurrentKva(tx, personId)) return null;
    return createKva(tx, personId, await currentKvaVersion(tx), actor);
}

/** Inserts an open agreement at `version`, with its audit row. */
export async function createKva(tx: TxClient, personId: number, version: number, actor: AuditActor) {
    const created = await tx.orgMembershipProcess.create({
        data: {
            kind: KVA_KIND,
            subjectPersonId: personId,
            orgMembershipId: null,
            status: "PENDING_EXTERNAL_ACTION",
            agreementVersion: version,
        },
    });
    await tx.auditLog.create({
        data: {
            ...actor,
            action: "CREATE",
            tableName: "OrgMembershipProcess",
            affectedEntityId: created.id,
            newData: { kind: KVA_KIND, status: "PENDING_EXTERNAL_ACTION", subjectPersonId: personId, agreementVersion: version },
        },
    });
    return created;
}

/**
 * Archives open, unsigned agreements matching `where`, one audit row each.
 * Returns the Zoho request ids they carried, for the caller to recall after
 * its transaction commits. An archived process never matches the Zoho webhook,
 * so a signature that lands before the recall changes nothing.
 */
export async function archiveOpenKvas(
    tx: TxClient,
    where: { subjectPersonId?: number; agreementVersion?: { lt: number } },
    actor: AuditActor,
    reason: string,
): Promise<string[]> {
    const open = await tx.orgMembershipProcess.findMany({
        where: { kind: KVA_KIND, contractSignedAt: null, ...where, ...fromWhere("PENDING_EXTERNAL_ACTION") },
        select: { id: true, zohoEnvelopeId: true },
    });
    const requestIds: string[] = [];
    for (const process of open) {
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: { id: process.id, contractSignedAt: null, ...fromWhere("PENDING_EXTERNAL_ACTION") },
            data: { status: "ARCHIVED", archivedFromStatus: "PENDING_EXTERNAL_ACTION", stageEnteredAt: new Date() },
        });
        if (count !== 1) continue;
        await tx.auditLog.create({
            data: {
                ...actor,
                action: "EDIT",
                tableName: "OrgMembershipProcess",
                affectedEntityId: process.id,
                oldData: { status: "PENDING_EXTERNAL_ACTION" },
                newData: { status: "ARCHIVED", reason },
            },
        });
        if (process.zohoEnvelopeId) requestIds.push(process.zohoEnvelopeId);
    }
    return requestIds;
}
