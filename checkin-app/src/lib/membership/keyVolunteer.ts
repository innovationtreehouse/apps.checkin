import prisma from "@/lib/prisma";
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { personActor } from "@/lib/auditActor";
import { zohoSign } from "@/lib/membership/contract/zohoProvider";
import { signingMockActive } from "@/lib/membership/contract/signingTarget";
import { kvaDocumentInPlace, KVA_FILENAME, loadKvaPdf } from "@/lib/membership/contract/agreementDocument";
import { ExternalError, pullSignatureStatus, signingUrlForProcess, type SigningDocument } from "@/lib/membership/external";
import { archiveOpenKvas, createKva, currentKvaVersion, findOpenKva } from "@/lib/membership/keyVolunteerProcess";

/**
 * The Key Volunteer Agreement's self-service signing and the Board's version
 * bump. Granting and removing the role is `setRoleFlag` (lib/roles.ts).
 * Rules: docs/rules/membership.md, "Key Volunteers".
 */

const KVA_DOCUMENT: SigningDocument = {
    load: () => loadKvaPdf(),
    filename: KVA_FILENAME,
    title: "Key Volunteer Agreement",
    unavailableMessage: "The Key Volunteer Agreement isn't ready yet. Please check back soon.",
    returnTo: { signed: "/membership?kva=signed", declined: "/membership?kva=declined", later: "/membership" },
};

/** `KeyVolunteerSelfStatus` (keyVolunteerSyntheticClassifications.ts). */
export interface KeyVolunteerSelfStatus {
    personId: number;
    owesSignature: boolean;
    agreementVersion: number;
    requestStarted: boolean;
    documentConfigured: boolean;
}

/** True when signing can load the document: the Zoho mock needs none. */
export async function kvaDocumentConfigured(): Promise<boolean> {
    if (await signingMockActive()) return true;
    try {
        return await kvaDocumentInPlace();
    } catch (e) {
        logger.error(`Key Volunteer Agreement document check failed: ${e instanceof Error ? e.message : String(e)}`);
        return false;
    }
}

/** The caller's own agreement status. */
export async function getKeyVolunteerSelfStatus(personId: number): Promise<KeyVolunteerSelfStatus> {
    const open = await findOpenKva(prisma, personId);
    return {
        personId,
        owesSignature: open !== null,
        agreementVersion: open?.agreementVersion ?? (await currentKvaVersion(prisma)),
        requestStarted: !!open?.zohoEnvelopeId,
        documentConfigured: await kvaDocumentConfigured(),
    };
}

/** The embedded sign URL for the caller's own open agreement; the first call creates the Zoho request. */
export async function startKeyVolunteerSigning(personId: number): Promise<{ personId: number; signUrl: string }> {
    const user = await prisma.person.findUnique({ where: { id: personId }, select: { id: true, email: true, name: true } });
    if (!user) throw new ExternalError("not_found", "Your account was not found.");
    const open = await findOpenKva(prisma, personId);
    if (!open) throw new ExternalError("wrong_phase", "You have no Key Volunteer Agreement to sign.");
    return { personId, signUrl: await signingUrlForProcess(open, user, KVA_DOCUMENT) };
}

/** The return-from-signing pull: records the signature if Zoho has it, then reports status. */
export async function syncKeyVolunteerSignature(personId: number): Promise<KeyVolunteerSelfStatus> {
    const open = await findOpenKva(prisma, personId);
    if (open) await pullSignatureStatus(open, personId);
    return getKeyVolunteerSelfStatus(personId);
}

/**
 * Best-effort recall of Zoho requests whose agreements were archived. A failed
 * recall is logged and left: the archived agreement no longer matches the
 * webhook, so a late signature changes nothing.
 */
export async function recallSigningRequests(requestIds: readonly string[]): Promise<void> {
    if (requestIds.length === 0 || !config.zohoAvailable()) return;
    try {
        const token = await zohoSign.getAccessToken();
        for (const requestId of requestIds) {
            try {
                await zohoSign.recallRequest(token, requestId);
            } catch (e) {
                logger.warn(`Recall of Zoho request ${requestId} failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    } catch (e) {
        logger.warn(`Zoho token for recalling ${requestIds.length} request(s) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}

/**
 * The Board's "new version (material change)": increments the version, archives
 * every open agreement at an older version, and opens one at the new version for
 * every live Key Volunteer. Removes no role. Recalls the archived agreements'
 * Zoho requests after the transaction commits.
 */
export async function bumpKeyVolunteerAgreementVersion(actorId: number): Promise<{ agreementVersion: number; agreementsOpened: number }> {
    const actor = personActor(actorId);
    const { agreementVersion, agreementsOpened, recallRequestIds } = await prisma.$transaction(async (tx) => {
        const settings = await tx.boardSettings.upsert({
            where: { id: 1 },
            create: { id: 1, keyVolunteerAgreementVersion: 2 },
            update: { keyVolunteerAgreementVersion: { increment: 1 } },
            select: { keyVolunteerAgreementVersion: true },
        });
        const version = settings.keyVolunteerAgreementVersion;
        await tx.auditLog.create({
            data: {
                ...actor,
                action: "EDIT",
                tableName: "BoardSettings",
                affectedEntityId: 1,
                oldData: { keyVolunteerAgreementVersion: version - 1 },
                newData: { keyVolunteerAgreementVersion: version },
            },
        });
        const recalls = await archiveOpenKvas(tx, { agreementVersion: { lt: version } }, actor, `Key Volunteer Agreement version ${version}`);
        const holders = await tx.personRole.findMany({
            where: { role: "KEY_VOLUNTEER", person: { mergedIntoId: null } },
            select: { personId: true },
        });
        let opened = 0;
        for (const { personId } of holders) {
            await createKva(tx, personId, version, actor);
            opened++;
        }
        return { agreementVersion: version, agreementsOpened: opened, recallRequestIds: recalls };
    });
    await recallSigningRequests(recallRequestIds);
    return { agreementVersion, agreementsOpened };
}
