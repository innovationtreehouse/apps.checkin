import prisma from "@/lib/prisma";
import type { OrgMembershipProcess } from "@/generated/prisma/client";
import { ServiceError } from "@checkin/component-kit";
import { EXTERNAL_ERROR_STATUS } from "@/lib/domainErrorResponse";
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { backgroundCheckProvider } from "@/lib/membership/background-check/manual-adapter";
import { applyVolunteerFamilyStatus } from "@/lib/membership/review";
import { householdCheckStarted } from "@/lib/membership/checkStanding";
import { zohoSign } from "@/lib/membership/contract/zohoProvider";
import { signingMockActive } from "@/lib/membership/contract/signingTarget";
import { SIGN_FIELDS, type SignFieldSpec } from "@/lib/membership/contract/signFields";
import { loadAgreementPdf, stampWatermark, AGREEMENT_FILENAME, AgreementUnavailableError, type LoadedAgreement } from "@/lib/membership/contract/agreementDocument";
import { latestPendingExternal } from "@/lib/membership/phases";
import { findOpenPersonAgreement } from "@/lib/membership/personAgreementTriggers";
import { asHouseholdProcess, fromWhere, openProcess, zohoWebhookMatchable } from "@/lib/membership/lifecycle";
import { systemActor, personActor, personOrSystemActor, recordAudit } from "@/lib/auditActor";
import { membershipYearLabel } from "@/lib/programYear";

/**
 * EXTERNAL-phase service — the actions an applicant completes after intake:
 * signing the Zoho contract and starting a lead's background check. Once the
 * contract is signed AND the check is handled (`householdCheckStarted`, or a
 * still-valid prior check detected), the application advances to PENDING_PAYMENT,
 * or to PENDING_BG_CLEARANCE when it is already paid.
 * The background check is NOT a gate on payment — it reviews in parallel and only
 * the final ACTIVE transition waits on it.
 *
 * The contract is recorded automatically (Zoho webhook) or manually by the
 * board. A check started is marked on the person whose check it is
 * (checkStarted.ts). The system never sees contract content or check results.
 *
 * A contract signature with no session behind it (the Zoho webhook) is attributed
 * to the `webhook:zoho-contract` system actor in the audit log.
 */

export type ExternalErrorCode =
    | "not_found"
    | "wrong_phase"
    | "not_lead"
    | "no_household"
    | "not_configured"
    | "agreement_unavailable"
    | "signing_in_progress";

export class ExternalError extends ServiceError {
    constructor(public readonly code: ExternalErrorCode, message: string) {
        super(EXTERNAL_ERROR_STATUS[code], message, code);
        this.name = "ExternalError";
    }
}

export interface ExternalStatus {
    contractSigned: boolean;
    /** True once a Zoho signing request exists — lets the UI say "Resume signing". */
    contractStarted: boolean;
    /** A lead's check is started, or the household's review waits to be named (`householdCheckStarted`). */
    checkStarted: boolean;
    /** True when a still-valid prior check was detected — no new check is needed. */
    bgCleared: boolean;
    deepLinkUrl: string | null;
    /** The lead the signing request is addressed to — after signing, who signed. */
    signerName: string | null;
    contractSignedAt: Date | null;
}

async function personName(personId: number | null): Promise<string | null> {
    if (!personId) return null;
    const person = await prisma.person.findUnique({ where: { id: personId }, select: { name: true, email: true } });
    return person?.name?.trim() || person?.email || null;
}

/** Applicant-facing status of the two external actions (+ the background-check tool's link). */
export async function getExternalStatus(process: {
    orgMembershipId: number | null;
    contractSignedAt: Date | null;
    bgConsentAt: Date | null;
    bgClearedAt: Date | null;
    zohoEnvelopeId: string | null;
    zohoSignerPersonId: number | null;
}): Promise<ExternalStatus> {
    return {
        contractSigned: !!process.contractSignedAt,
        contractStarted: !!process.zohoEnvelopeId,
        checkStarted: await applicationCheckStarted(process),
        bgCleared: !!process.bgClearedAt,
        deepLinkUrl: await backgroundCheckProvider.getConsentDeepLink(),
        signerName: await personName(process.zohoSignerPersonId),
        contractSignedAt: process.contractSignedAt,
    };
}

/** `householdCheckStarted` for the household a household application belongs to. */
async function applicationCheckStarted(process: { orgMembershipId: number | null; bgConsentAt: Date | null }): Promise<boolean> {
    if (process.orgMembershipId === null) return false;
    const membership = await prisma.orgMembership.findUnique({ where: { id: process.orgMembershipId }, select: { householdId: true } });
    return !!membership && householdCheckStarted(prisma, membership.householdId, process);
}

/**
 * Once the contract is signed AND the background check is handled — either a
 * still-valid prior check (bgClearedAt) or the check started
 * (`householdCheckStarted`) — advance from EXTERNAL to PENDING_PAYMENT. RENEWAL processes take
 * this gate too: a fresh agreement is signed every cycle (beginRenewal), and a
 * still-valid background check arrives here pre-cleared so only the signature
 * is pending. The background check does not gate payment: when it still needs
 * a human review (no still-valid prior background check), it runs in PARALLEL
 * while the applicant pays, and only the final ACTIVE flip waits on it.
 *
 * An application already paid (an order recorded while BLOCKED or unsigned) owes no
 * payment, so it goes to PENDING_BG_CLEARANCE instead, and `settleHouseholdBg`
 * converges it: activates it, or holds it and raises a refunded order.
 *
 * The conditional updateMany (status guard) is the atomic gate: two concurrent
 * callers (Zoho webhook + a check marked started) both reach here, but only the
 * one whose updateMany flips PENDING_EXTERNAL_ACTION sees count === 1 — so the
 * audit row is written exactly once, and a later status is never regressed. Mirrors review.ts `attest`.
 */
export async function advanceExternalIfComplete(processId: number) {
    return advanceExternal(processId, true);
}

async function advanceExternal(processId: number, retryOnLoss: boolean): Promise<OrgMembershipProcess | null> {
    const process = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
    if (!process) return process;
    if (process.status !== "PENDING_EXTERNAL_ACTION") return process;
    if (!process.contractSignedAt) return process;
    const started = !process.bgClearedAt && (await applicationCheckStarted(process));
    if (!process.bgClearedAt && !started) return process;
    const paid = !!process.paidAt;
    const to = paid ? "PENDING_BG_CLEARANCE" : "PENDING_PAYMENT";

    const { orgMembershipId } = asHouseholdProcess(process);
    const advanced = await prisma.$transaction(async (tx) => {
        const membership = await tx.orgMembership.findUnique({
            where: { id: orgMembershipId },
            select: { householdId: true },
        });
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: {
                id: processId,
                // Advance CAS from-state from the definition; the contract/BG/paid narrowing stays literal.
                ...fromWhere("PENDING_EXTERNAL_ACTION"),
                contractSignedAt: { not: null },
                paidAt: paid ? { not: null } : null,
                ...(started ? {} : { bgClearedAt: { not: null } }),
            },
            // Settle converges only an uncleared row; it re-reads the household's standing and stamps it again.
            data: { status: to, stageEnteredAt: new Date(), ...(paid ? { bgClearedAt: null } : {}) },
        });
        if (count !== 1) return null; // lost the race or no longer eligible — no audit, no notify
        // The membership fee is read at PENDING_PAYMENT (ensurePaymentLink), normally BEFORE the
        // background check clears — so a pre-designated volunteer family must get
        // isVolunteerFamily here, not only at clearance. Sticky + idempotent;
        // clearBackgroundCheck's reviewer-marked pass remains the supplement.
        if (membership) await applyVolunteerFamilyStatus(tx, orgMembershipId, membership.householdId, false);
        await tx.auditLog.create({
            data: {
                ...systemActor("system:membership-external-advance"),
                action: "EDIT",
                tableName: "OrgMembershipProcess",
                affectedEntityId: processId,
                oldData: { status: "PENDING_EXTERNAL_ACTION" },
                newData: { status: to, ...(paid ? { paid: true, bgCleared: false } : {}) },
            },
        });
        return { householdId: membership?.householdId ?? null };
    });
    // A refund between the read and the CAS clears paidAt and fails the CAS; read again once.
    if (!advanced && retryOnLoss) return advanceExternal(processId, false);
    const householdId = advanced?.householdId ?? null;
    if (paid && householdId !== null) {
        // Lazy: settleHouseholdBg imports this module.
        const { settleAfterEvent } = await import("@/lib/membership/settleHouseholdBg");
        await settleAfterEvent(householdId, "a paid application's advance", {}, { processId });
    }
    // Reviewers are pinged when the household's check review opens, not here.
    return prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
}

/**
 * Record that the membership contract was signed (idempotent), then maybe advance.
 *
 * A per-person agreement (PERSON_AGREEMENT, KEY_VOLUNTEER_AGREEMENT) completes on the
 * signature alone — it has no membership, no payment and no BG gate — so it flips
 * straight to the terminal ACTIVE in the same conditional write and skips
 * advanceExternalIfComplete entirely (which would deref a null orgMembershipId).
 *
 * A board-recorded signature clears the signer: the request's addressee may never
 * have signed, and the record must not name someone who didn't.
 */
export async function markContractSigned(processId: number, actorId?: number, recordedByBoard = false) {
    const process = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
    if (!process) throw new ExternalError("not_found", "Application not found.");
    const isPersonAgreement = process.kind === "PERSON_AGREEMENT" || process.kind === "KEY_VOLUNTEER_AGREEMENT";
    // Conditional on contractSignedAt: null — two concurrent Zoho webhook retries
    // both see null, but only the winner's updateMany flips it (count === 1), so the
    // audit row is written once. A per-person agreement also requires its from-state, so
    // an archived agreement can never flip to ACTIVE. Household processes may be
    // pre-marked signed before EXTERNAL (intake), so theirs has no status clause.
    await prisma.$transaction(async (tx) => {
        const signedAt = new Date();
        const signed = { contractSignedAt: signedAt, ...(recordedByBoard ? { zohoSignerPersonId: null } : {}) };
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: { id: processId, contractSignedAt: null, ...(isPersonAgreement ? fromWhere("PENDING_EXTERNAL_ACTION") : {}) },
            data: isPersonAgreement ? { ...signed, status: "ACTIVE", stageEnteredAt: signedAt } : signed,
        });
        if (count !== 1) return;
        await tx.auditLog.create({
            data: {
                ...personOrSystemActor(actorId, "webhook:zoho-contract"),
                action: "EDIT",
                tableName: "OrgMembershipProcess",
                affectedEntityId: processId,
                newData: {
                    contractSignedAt: true,
                    ...(isPersonAgreement ? { status: "ACTIVE" } : {}),
                    ...(recordedByBoard ? { zohoSignerPersonId: null } : {}),
                },
            },
        });
    });
    if (isPersonAgreement) return prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
    return advanceExternalIfComplete(processId);
}

/**
 * Asks Zoho about a stored request the app has no signature for, and records one it
 * finds. The webhook cannot match a closed application, so this is how a signature
 * made while closed reaches a reopened one. Attributed to the webhook actor: whoever
 * triggered the check did not sign. Best-effort: on any failure the application
 * stays unsigned and "Resume signing" asks again. A dead request is left for that
 * click to replace. The mock answers "completed" for every request, so it is skipped.
 */
export async function pickUpMissedSignature(process: Pick<OrgMembershipProcess, "id" | "contractSignedAt" | "zohoEnvelopeId">) {
    if (process.contractSignedAt || !process.zohoEnvelopeId || !config.zohoAvailable()) return;
    try {
        if (await signingMockActive()) return;
        const token = await zohoSign.getAccessToken();
        if ((await zohoSign.getRequestStatus(token, process.zohoEnvelopeId)) === "completed") await markContractSigned(process.id);
    } catch (e) {
        logger.warn(`Zoho signature check failed for membership process ${process.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
}

/**
 * Year-end close of an open, unsigned agreement whose year has ended. Zoho is asked
 * about a stored request first: a signature found is recorded on the agreement instead,
 * and a live request is recalled before the close, so none outlives it. A failed Zoho
 * call throws and leaves the agreement open for the next night's pass.
 */
export async function closeEndedPersonAgreement(process: Pick<OrgMembershipProcess, "id" | "zohoEnvelopeId" | "membershipYear">): Promise<"signed" | "closed" | "unchanged"> {
    const requestId = process.zohoEnvelopeId;
    if (requestId && config.zohoAvailable() && !(await signingMockActive())) {
        const token = await zohoSign.getAccessToken();
        const state = await zohoSign.getRequestStatus(token, requestId);
        if (state === "completed") {
            await markContractSigned(process.id);
            return "signed";
        }
        if (state !== "terminal") await zohoSign.recallRequest(token, requestId);
    }
    const year = process.membershipYear === null ? "its year" : membershipYearLabel(process.membershipYear);
    return prisma.$transaction(async (tx) => {
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: { id: process.id, kind: "PERSON_AGREEMENT", contractSignedAt: null, zohoEnvelopeId: requestId, ...fromWhere("PENDING_EXTERNAL_ACTION") },
            data: { status: "ARCHIVED", archivedFromStatus: "PENDING_EXTERNAL_ACTION", stageEnteredAt: new Date() },
        });
        if (count !== 1) return "unchanged" as const;
        await tx.auditLog.create({
            data: {
                ...systemActor("system:person-agreement-year-end"),
                action: "EDIT",
                tableName: "OrgMembershipProcess",
                affectedEntityId: process.id,
                oldData: { status: "PENDING_EXTERNAL_ACTION" },
                newData: { status: "ARCHIVED", membershipYear: process.membershipYear, reason: `closed unsigned at the end of ${year}` },
            },
        });
        return "closed" as const;
    });
}

/**
 * Associate a Zoho signing request id with a process so its webhook can match.
 * Clears zohoActionId: re-pointing the envelope would otherwise leave the old
 * action id paired with the new request, an unsignable mismatch that
 * the null-claim repair in claimAndCreateRequest, inside signingUrlForProcess,
 * can't fix (both ids non-null).
 * Nulling the action id restores the claimable envelope-without-action state its
 * claim already handles — the same recovery clearDeadSigningRequest relies on.
 */
export async function setZohoEnvelope(processId: number, requestId: string, actorId: number) {
    const process = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
    if (!process) throw new ExternalError("not_found", "Application not found.");
    // A signed process keeps its envelope and signer: re-pointing it would erase who signed.
    return prisma.$transaction(async (tx) => {
        const { count } = await tx.orgMembershipProcess.updateMany({ where: { id: processId, contractSignedAt: null, ...openProcess.where }, data: { zohoEnvelopeId: requestId, zohoActionId: null, zohoSignerPersonId: null } });
        if (!count) throw new ExternalError("wrong_phase", "This application is closed or already signed; its signing request can't be changed.");
        const updated = await tx.orgMembershipProcess.findUniqueOrThrow({ where: { id: processId } });
        await recordAudit(tx, personActor(actorId), {
            action: "EDIT",
            tableName: "OrgMembershipProcess",
            affectedEntityId: processId,
            newData: { zohoEnvelopeId: requestId, zohoActionId: null, zohoSignerPersonId: null },
        });
        return updated;
    });
}

/** Find the process tied to a Zoho request id (for webhook matching); archived processes never match. */
export async function findProcessByEnvelope(requestId: string) {
    return prisma.orgMembershipProcess.findFirst({ where: { zohoEnvelopeId: requestId, ...zohoWebhookMatchable.where } });
}

/**
 * Forget a dead Zoho signing request (declined/expired/recalled) so the next
 * "sign" click creates a fresh one — the applicant's self-serve recovery.
 * Conditional on the process still pointing at THAT request and being unsigned,
 * so a concurrent re-create's fresh ids are never clobbered and the audit row is
 * written only by the caller that actually cleared.
 */
async function clearDeadSigningRequest(processId: number, requestId: string, actorId: number) {
    const cleared = await prisma.$transaction(async (tx) => {
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: { id: processId, zohoEnvelopeId: requestId, contractSignedAt: null },
            data: { zohoEnvelopeId: null, zohoActionId: null, zohoSignerPersonId: null },
        });
        if (count !== 1) return false;
        await tx.auditLog.create({
            data: {
                actorId,
                action: "EDIT",
                tableName: "OrgMembershipProcess",
                affectedEntityId: processId,
                oldData: { zohoEnvelopeId: requestId },
                newData: { zohoEnvelopeId: null, zohoActionId: null, zohoSignerPersonId: null },
            },
        });
        return true;
    });
    if (cleared) logger.info(`Cleared dead Zoho signing request ${requestId} for membership process ${processId}.`);
}

/**
 * Which process this caller signs, shared by the signing action and the return-from-
 * signing sync so the two can never disagree.
 *
 * A household lead ALWAYS signs the household INITIAL/RENEWAL process — `isHouseholdLead`
 * is checked FIRST, so a stray open PERSON_AGREEMENT on someone who is (or becomes) a
 * lead can never shadow it and stall activation/renewal with no UI explanation. The
 * NOT-lead guard on the triggers should keep a lead from ever having one; this ordering
 * is the backstop.
 *
 * Otherwise the caller's own open PERSON_AGREEMENT wins — they are signing for
 * themselves, so the household lead-only gate does not apply to them.
 */
async function resolveSigningProcess(
    userId: number,
    isHouseholdLead: boolean,
    householdProcesses: OrgMembershipProcess[] | undefined,
): Promise<{ process: OrgMembershipProcess | undefined; isOwnAgreement: boolean }> {
    if (!isHouseholdLead) {
        const own = await findOpenPersonAgreement(userId);
        if (own) return { process: own, isOwnAgreement: true };
    }
    return { process: latestPendingExternal(householdProcesses), isOwnAgreement: false };
}

/**
 * Pull the contract status from Zoho for the applicant's in-flight process and
 * record it signed if Zoho says so. Called when the signer returns from embedded
 * signing (?signed=1) so completion doesn't hinge on the inbound webhook — which
 * is unreliable against a scale-to-zero dev instance that may be asleep when Zoho
 * fires it. Best-effort: a Zoho hiccup is swallowed (the webhook is the backstop)
 * and the current status is returned regardless. Returns null when the user has no
 * in-flight signing process.
 */
export async function syncContractStatus(userId: number): Promise<ExternalStatus | null> {
    const user = await prisma.person.findUnique({
        where: { id: userId },
        include: { household: { include: { orgMembership: { include: { processes: true } } } } },
    });
    if (!user) return null;
    // Same selection as the signing action — including a PERSON_AGREEMENT, which can
    // never appear in household.orgMembership.processes (its orgMembershipId is null).
    // Without this the subject's signature only lands if the unreliable Zoho webhook
    // fires, and a re-click mints a second signing ceremony for a signed agreement.
    const { process } = await resolveSigningProcess(user.id, user.isHouseholdLead, user.household?.orgMembership?.processes);
    if (!process) return null;

    const fresh = await pullSignatureStatus(process, userId);
    return fresh ? getExternalStatus(fresh) : null;
}

/**
 * Asks Zoho whether `process`'s signing request is complete and records the
 * signature if so; forgets a dead request so the next click creates a fresh one.
 * Best-effort: a Zoho failure is logged, since the webhook is the backstop.
 * Returns the re-read process.
 */
export async function pullSignatureStatus(process: OrgMembershipProcess, userId: number) {
    if (!process.contractSignedAt && process.zohoEnvelopeId && config.zohoAvailable()) {
        try {
            const token = await zohoSign.getAccessToken();
            const state = await zohoSign.getRequestStatus(token, process.zohoEnvelopeId);
            if (state === "completed") {
                await markContractSigned(process.id, userId);
            } else if (state === "terminal") {
                // Declined or expired — forget the dead request so contractStarted
                // resets and the next click creates a fresh one.
                await clearDeadSigningRequest(process.id, process.zohoEnvelopeId, userId);
            }
        } catch (e) {
            logger.error(`Zoho status sync failed for process ${process.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    // Re-read: markContractSigned may have flipped contractSignedAt (and advanced the phase).
    return prisma.orgMembershipProcess.findUnique({ where: { id: process.id } });
}

/**
 * Zoho charges per request, so a lead never gets a request of their own while
 * another lead's is open and unsigned: only the board's resetSigning frees it.
 */
async function assertSignerIs(signerId: number | null, userId: number) {
    if (!signerId || signerId === userId) return;
    const name = (await personName(signerId)) ?? "Another household lead";
    throw new ExternalError(
        "signing_in_progress",
        `${name} started signing. Ask ${name} to finish, or ask the board to reset the signing so you can sign.`,
    );
}

/** Days an applicant has to sign before the Zoho request expires (mirrors the script's default). */
const CONTRACT_EXPIRATION_DAYS = 15;

/** The document a signing request carries and where Zoho returns the signer. */
export interface SigningDocument {
    /** Reads the PDF; throws AgreementUnavailableError when it is not in place. */
    load: () => Promise<LoadedAgreement>;
    filename: string;
    /** The request's name in Zoho, before the signer's name. */
    title: string;
    unavailableMessage: string;
    /** App paths Zoho navigates the signer to when they finish, decline, or leave. */
    returnTo: { signed: string; declined: string; later: string };
    /** Where the signer's fields sit on the PDF's last page. */
    fieldSpecs: readonly SignFieldSpec[];
}

const MEMBERSHIP_AGREEMENT: SigningDocument = {
    load: () => loadAgreementPdf(),
    filename: AGREEMENT_FILENAME,
    fieldSpecs: SIGN_FIELDS,
    title: "Membership Agreement",
    unavailableMessage: "The membership agreement isn't ready yet. Please check back soon.",
    // signed=1 lets the membership page confirm + refresh.
    returnTo: { signed: "/membership?signed=1", declined: "/membership?declined=1", later: "/membership" },
};

/**
 * A claim with no request ids this old has lost its holder and can be taken over.
 * Far longer than the holder's Zoho calls, each capped by ZOHO_FETCH_TIMEOUT_MS.
 */
const SIGNING_CLAIM_WINDOW_MS = 5 * 60_000;

/** Recall a request no one will ever be sent to, so it can't stay live beside the stored one. */
async function recallUnstoredRequest(token: string, requestId: string, processId: number) {
    try {
        await zohoSign.recallRequest(token, requestId);
    } catch (e) {
        logger.error(`Could not recall unstored Zoho request ${requestId} for membership process ${processId}: ${e instanceof Error ? e.message : String(e)}`);
    }
}

/**
 * Applicant-facing "Sign your membership agreement" action. Idempotent: the Zoho
 * signing request/document is created at most once (its request + action ids are
 * stored on the process), then every call mints a fresh short-lived EMBEDDED sign
 * URL so the applicant goes straight into the signing ceremony in-app.
 *
 * Returns the embedded sign URL. Throws ExternalError for the caller to map to HTTP.
 */
export async function getOrCreateContractSigningUrl(userId: number): Promise<string> {
    if (!config.zohoAvailable()) {
        throw new ExternalError("not_configured", "Agreement signing isn't available yet. Please check back soon.");
    }

    const user = await prisma.person.findUnique({
        where: { id: userId },
        include: {
            household: { include: { orgMembership: { include: { processes: true } } } },
        },
    });
    if (!user) throw new ExternalError("not_found", "Application not found.");

    // Any kind in the EXTERNAL phase — INITIAL applications AND renewals, which
    // re-sign the agreement fresh each cycle, plus the caller's own PERSON_AGREEMENT.
    // Gating on status alone keeps this in step with getIntakeState/getExternalStatus,
    // which surface the button for any non-ACTIVE process (a kind filter here would
    // render the button then 409).
    const { process, isOwnAgreement } = await resolveSigningProcess(user.id, user.isHouseholdLead, user.household?.orgMembership?.processes);

    // The household gates apply only to the household agreement. Signing your OWN
    // agreement needs neither a household application in flight nor a lead role — that
    // bypass is the point of the individual agreement.
    if (!isOwnAgreement) {
        if (!user.householdId) throw new ExternalError("no_household", "You must create a household first.");
        if (!user.isHouseholdLead && !user.isSysadmin) {
            throw new ExternalError("not_lead", "Only a household lead can sign the membership agreement.");
        }
    }
    if (!process) throw new ExternalError("wrong_phase", "No application is awaiting your signature.");

    return signingUrlForProcess(process, user, MEMBERSHIP_AGREEMENT);
}

/** Who a signing request is addressed to. */
interface SigningRecipient {
    email: string;
    name: string;
}

/** The stored Zoho ids an embedded sign URL is minted from. */
interface SigningIds {
    requestId: string;
    actionId: string;
}

/**
 * The embedded sign URL for `user` on `process`, creating the Zoho request on the
 * first call and reusing it after. Shared by every agreement the app signs.
 */
export async function signingUrlForProcess(
    process: OrgMembershipProcess,
    user: { id: number; email: string | null; name: string | null },
    document: SigningDocument,
): Promise<string> {
    if (!config.zohoAvailable()) {
        throw new ExternalError("not_configured", "Agreement signing isn't available yet. Please check back soon.");
    }
    const userId = user.id;
    if (!user.email) throw new ExternalError("not_found", "Your account has no email on file to sign with.");
    const recipient: SigningRecipient = { email: user.email, name: user.name?.trim() || user.email };

    const token = await zohoSign.getAccessToken();

    // Create the request once; reuse the stored ids on every later click so the
    // document is never re-generated (only the embed session below is ephemeral).
    let requestId = process.zohoEnvelopeId;
    let actionId = process.zohoActionId;

    if (requestId && !process.contractSignedAt) {
        if (await storedRequestIsLive(process, requestId, token, userId)) {
            await assertSignerIs(process.zohoSignerPersonId, userId);
        } else {
            requestId = null;
            actionId = null;
        }
    }

    if (!requestId || !actionId) {
        ({ requestId, actionId } = await claimAndCreateRequest(process, userId, token, document, recipient));
    }

    return zohoSign.getEmbeddedSignUrl({ token, requestId, actionId, host: config.baseUrl() });
}

/**
 * A stored request may be dead — declined by the signer, or expired after
 * CONTRACT_EXPIRATION_DAYS — and Zoho can neither embed nor revive it. Returns
 * false once a dead request is forgotten, so the caller falls through to create a
 * fresh one and the same button self-recovers. A request already signed gets its
 * signature recorded and throws instead of returning a link. Best-effort — if the
 * status read fails, the stored ids are kept rather than blocking the click (worst
 * case the embed call fails).
 */
async function storedRequestIsLive(process: OrgMembershipProcess, requestId: string, token: string, userId: number): Promise<boolean> {
    let live = true;
    let signedAtZoho = false;
    try {
        const state = await zohoSign.getRequestStatus(token, requestId);
        signedAtZoho = state === "completed";
        if (state === "terminal") {
            await clearDeadSigningRequest(process.id, requestId, userId);
            live = false;
        }
    } catch (e) {
        logger.warn(`Zoho request-status check failed for membership process ${process.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    // The mock answers "completed" for every request; only its interstitial signs.
    if (signedAtZoho && !(await signingMockActive())) {
        await markContractSigned(process.id, userId);
        throw new ExternalError("wrong_phase", "This agreement has already been signed.");
    }
    return live;
}

/**
 * Claim before creating: Zoho charges per request, so only the claim's winner ever
 * calls createRequest, and a concurrent click is told to wait instead of paying for
 * an orphan. The claim matches an INCOMPLETE pair (either id null), not just a null
 * envelope: setZohoEnvelope (the admin/email flow) stores an envelope WITHOUT an
 * action id, which can't be embedded, so that state must stay claimable. A claim
 * whose holder died before storing ids is claimable once past the window.
 */
async function claimAndCreateRequest(
    process: OrgMembershipProcess,
    userId: number,
    token: string,
    document: SigningDocument,
    recipient: SigningRecipient,
): Promise<SigningIds> {
    const claimedAt = new Date();
    const claim = await prisma.orgMembershipProcess.updateMany({
        where: {
            id: process.id,
            OR: [{ zohoEnvelopeId: null }, { zohoActionId: null }],
            AND: [{ OR: [{ zohoSignerPersonId: null }, { zohoClaimedAt: { lt: new Date(claimedAt.getTime() - SIGNING_CLAIM_WINDOW_MS) } }] }],
        },
        data: { zohoSignerPersonId: userId, zohoClaimedAt: claimedAt },
    });
    if (claim.count === 0) {
        const current = await prisma.orgMembershipProcess.findUnique({ where: { id: process.id } });
        await assertSignerIs(current?.zohoSignerPersonId ?? null, userId);
        const requestId = current?.zohoEnvelopeId;
        const actionId = current?.zohoActionId;
        if (!requestId || !actionId) {
            throw new ExternalError("wrong_phase", "Your signing request is still being prepared. Please try again in a moment.");
        }
        logger.info(`Concurrent signing request for membership process ${process.id}; reusing stored ${requestId}.`);
        return { requestId, actionId };
    }

    // Matching on claimedAt stops a holder that was taken over from touching the newer claim.
    const ownClaim = { id: process.id, zohoSignerPersonId: userId, zohoClaimedAt: claimedAt };
    const releaseClaim = () => prisma.orgMembershipProcess.updateMany({
        where: { ...ownClaim, OR: [{ zohoEnvelopeId: null }, { zohoActionId: null }] },
        data: { zohoSignerPersonId: null },
    });

    let created: Awaited<ReturnType<typeof zohoSign.createRequest>>;
    try {
        created = await createSigningRequest(token, document, recipient);
    } catch (e) {
        // Release the claim so the next click can retry.
        await releaseClaim();
        throw e;
    }

    const { requestId, actionId } = created;
    let stored: number;
    try {
        stored = await prisma.$transaction(async (tx) => {
            const { count } = await tx.orgMembershipProcess.updateMany({
                where: ownClaim,
                data: { zohoEnvelopeId: requestId, zohoActionId: actionId },
            });
            if (count) {
                await recordAudit(tx, personActor(userId), {
                    action: "EDIT",
                    tableName: "OrgMembershipProcess",
                    affectedEntityId: process.id,
                    newData: { zohoEnvelopeId: requestId, zohoActionId: actionId, zohoSignerPersonId: userId },
                });
            }
            return count;
        });
    } catch (e) {
        await recallUnstoredRequest(token, created.requestId, process.id);
        // If this fails too, the window frees the claim.
        await releaseClaim().catch((releaseError) => logger.error(`Could not release signing claim for membership process ${process.id}: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`));
        throw e;
    }
    if (stored === 0) {
        await recallUnstoredRequest(token, requestId, process.id);
        throw new ExternalError("wrong_phase", "Signing was reset while your request was being prepared. Please try again.");
    }
    logger.info(`Created Zoho signing request ${requestId} for membership process ${process.id}.`);
    return { requestId, actionId };
}

/** Creates and submits the Zoho request for `document`, addressed to `recipient`. */
async function createSigningRequest(token: string, document: SigningDocument, recipient: SigningRecipient) {
    // Resolved ONCE for this request so the PDF-skip, watermark, and the
    // provider calls below can't disagree if the dev signing-target radio
    // flips mid-flow (signingMockActive also honors BoardSettings.devSigningTarget).
    const signingMock = await signingMockActive();
    const { agreement, pdf, requestName } = await buildAgreementPdf(document, signingMock, recipient.name);

    // Return the embedded signer to checkin when they finish (Zoho navigates
    // the window to these).
    const base = config.baseUrl();
    const created = await zohoSign.createRequest({
        token,
        pdf,
        filename: document.filename,
        recipientEmail: recipient.email,
        recipientName: recipient.name,
        requestName,
        expirationDays: CONTRACT_EXPIRATION_DAYS,
        redirectPages: {
            sign_completed: `${base}${document.returnTo.signed}`,
            sign_success: `${base}${document.returnTo.signed}`,
            sign_declined: `${base}${document.returnTo.declined}`,
            sign_later: `${base}${document.returnTo.later}`,
        },
    });
    await zohoSign.submitRequest({
        token,
        requestId: created.requestId,
        actionId: created.actionId,
        documentId: created.documentId,
        recipientEmail: recipient.email,
        recipientName: recipient.name,
        lastPageNo: agreement.lastPageNo,
        pageWidth: agreement.pageWidth,
        pageHeight: agreement.pageHeight,
        fieldSpecs: document.fieldSpecs,
        prefill: { PrintedName: recipient.name },
    });
    return created;
}

/** The PDF bytes and request name to send for `document`, marked as a test off prod. */
async function buildAgreementPdf(document: SigningDocument, signingMock: boolean, recipientName: string) {
    // Mock mode never uploads the PDF (its createRequest ignores the bytes), so
    // skip the S3 load that also 503s in dev — an empty placeholder keeps the
    // create/submit calls type-identical. See docs/ops/contract-signing-mock.md.
    let agreement: LoadedAgreement;
    if (signingMock) {
        agreement = { pdf: Buffer.alloc(0), lastPageNo: 0, pageWidth: 0, pageHeight: 0 };
    } else {
        try {
            agreement = await document.load();
        } catch (e) {
            if (e instanceof AgreementUnavailableError) {
                throw new ExternalError("agreement_unavailable", document.unavailableMessage);
            }
            throw e;
        }
    }

    // On non-prod instances, mark the request + document as a DEV test so a
    // signature can never be mistaken for a binding one — baked in server-side
    // (CHECKIN_ENV), not editable by the applicant. Prod stays clean. The
    // create/submit/embed flow is otherwise identical across envs. (Mock mode
    // skips the watermark — the empty placeholder PDF is never rendered.)
    //
    // ops-stg is a SEPARATE exclusion, not a CheckinEnv value: CHECKIN_ENV=stg
    // falls back to 'prod' (readCheckinEnv), so config.isProd() alone would
    // call ops-stg's signing flow "prod" and produce a watermark-free document
    // indistinguishable from a real binding agreement the moment a Zoho
    // credential is ever wired to staging to rehearse signing.
    const isProd = config.isProd() && !config.isStaging();
    const pdf = isProd || signingMock ? agreement.pdf : await stampWatermark(agreement.pdf, "DEV TEST — NOT A LEGAL AGREEMENT");
    const requestName = `${isProd ? "" : "[DEV TEST — NOT BINDING] "}${document.title} — ${recipientName}`;
    return { agreement, pdf, requestName };
}

/**
 * Board "reset signing": recall the open Zoho request and forget it, so the next
 * lead to click gets a fresh request addressed to them. Each reset costs one more
 * Zoho request, which is why it takes a board member and a stated reason. The
 * conflict-of-interest check lives on the route, like the other board actions.
 */
export async function resetSigning(processId: number, actorId: number, reason: string) {
    const process = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
    if (!process) throw new ExternalError("not_found", "Application not found.");
    const requestId = process.zohoEnvelopeId;
    // A signer with no request yet is a claim whose create never finished.
    if (process.contractSignedAt || (!requestId && !process.zohoSignerPersonId)) {
        throw new ExternalError("wrong_phase", "There is no open, unsigned signing request to reset.");
    }

    if (requestId && config.zohoAvailable()) {
        const token = await zohoSign.getAccessToken();
        try {
            await zohoSign.recallRequest(token, requestId);
        } catch (e) {
            // Zoho refuses to recall a request that is already dead or signed.
            const state = await zohoSign.getRequestStatus(token, requestId);
            if (state === "completed") {
                await markContractSigned(processId);
                throw new ExternalError("wrong_phase", "This agreement has already been signed. Refresh to see it.");
            }
            if (state !== "terminal") throw e;
        }
    }

    const cleared = await prisma.$transaction(async (tx) => {
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: { id: processId, zohoEnvelopeId: requestId, zohoSignerPersonId: process.zohoSignerPersonId, contractSignedAt: null },
            data: { zohoEnvelopeId: null, zohoActionId: null, zohoSignerPersonId: null },
        });
        if (count !== 1) return false;
        await tx.auditLog.create({
            data: {
                actorId,
                action: "EDIT",
                tableName: "OrgMembershipProcess",
                affectedEntityId: processId,
                oldData: { zohoEnvelopeId: requestId, zohoActionId: process.zohoActionId, zohoSignerPersonId: process.zohoSignerPersonId },
                newData: { zohoEnvelopeId: null, zohoActionId: null, zohoSignerPersonId: null, resetSigningReason: reason },
            },
        });
        return true;
    });
    if (!cleared) throw new ExternalError("wrong_phase", "The signing request changed while resetting. Refresh and try again.");
    logger.info(`Board reset Zoho signing request ${requestId} for membership process ${processId}.`);
    return prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
}
