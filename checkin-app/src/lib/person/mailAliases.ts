import type { AuditActor } from "@/lib/auditActor";
import type { TxClient } from "@/lib/db-client";
import { canonicalizeEmail } from "@/lib/emailNormalize";

const MAIL_ALIAS_ADVISORY_CLASS = 4;

/** Serialises every alias add and sign-in email write on one canonical address. */
export async function lockMailAliasKey(tx: TxClient, canonicalKey: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MAIL_ALIAS_ADVISORY_CLASS}::int, hashtext(${canonicalKey}))`;
}

/**
 * Every write of Person.email calls this, in the write's transaction and before the write, when
 * the address changes: an address that signs someone in is nobody's alias. It deletes every alias
 * on the address's canonical key, of that person or anyone else (mailAliases.test.ts enforces the
 * callers). The audit row carries no address.
 */
export async function removeAliasesForSignInEmail(tx: TxClient, email: string, actor: AuditActor, cause: string): Promise<void> {
    const canonicalKey = canonicalizeEmail(email);
    await lockMailAliasKey(tx, canonicalKey);
    const aliases = await tx.personMailAlias.findMany({ where: { canonicalKey }, select: { id: true, personId: true, addedById: true, approvedById: true } });
    for (const { id, personId, addedById, approvedById } of aliases) {
        await tx.personMailAlias.delete({ where: { id } });
        await tx.auditLog.create({
            data: {
                ...actor,
                action: "DELETE",
                tableName: "PersonMailAlias",
                affectedEntityId: id,
                secondaryAffectedEntity: personId,
                oldData: { personId, addedById, approvedById },
                newData: { reason: "sign_in_email_change", cause },
            },
        });
    }
}
