import prisma from "@/lib/prisma";
import type { OrgMembershipProcess } from "@/generated/prisma/client";
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { backgroundCheckProvider } from "@/lib/membership/background-check/manual-adapter";
import { notifyReviewers, applyVolunteerStatus } from "@/lib/membership/review";
import { zohoSign } from "@/lib/membership/contract/zohoProvider";
import { signingMockActive } from "@/lib/membership/contract/signingTarget";
import { loadAgreementPdf, stampWatermark, AGREEMENT_FILENAME, AgreementUnavailableError } from "@/lib/membership/contract/agreementDocument";
import { latestPendingExternal } from "@/lib/membership/phases";
import { findOpenPersonAgreement } from "@/lib/membership/personAgreementTriggers";
import { fromWhere, zohoWebhookMatchable } from "@/lib/membership/lifecycle";
import { systemActor, personOrSystemActor } from "@/lib/auditActor";

/**
 * EXTERNAL-phase service — the actions an applicant completes after intake:
 * signing the Zoho contract and consenting to a background check on Averity.
 * Once the contract is signed AND the check is handled (consent recorded, or a
 * still-valid prior check detected), the application advances to PENDING_PAYMENT.
 * The background check is NOT a gate on payment — it reviews in parallel and only
 * the final ACTIVE transition waits on it.
 *
 * The contract is recorded automatically (Zoho webhook) or manually by the
 * board. BG consent is human-marked (no Averity API): the applicant self-reports
 * after submitting on Averity (selfRecordBgConsent, #875), with the board's
 * mark-bg-consent action as the backstop. The system never sees contract content
 * or check results.
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

export class ExternalError extends Error {
    constructor(public readonly code: ExternalErrorCode, message: string) {
        super(message);
        this.name = "ExternalError";
    }
}

export interface ExternalStatus {
    contractSigned: boolean;
    /** True once a Zoho signing request exists — lets the UI say "Resume signing". */
    contractStarted: boolean;
    bgConsented: boolean;
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

/** Applicant-facing status of the two external actions (+ the consent deep link). */
export async function getExternalStatus(process: {
    contractSignedAt: Date | null;
    bgConsentAt: Date | null;
    bgClearedAt: Date | null;
    zohoEnvelopeId: string | null;
    zohoSignerPersonId: number | null;
}): Promise<ExternalStatus> {
    return {
        contractSigned: !!process.contractSignedAt,
        contractStarted: !!process.zohoEnvelopeId,
        bgConsented: !!process.bgConsentAt,
        bgCleared: !!process.bgClearedAt,
        deepLinkUrl: await backgroundCheckProvider.getConsentDeepLink(),
        signerName: await personName(process.zohoSignerPersonId),
        contractSignedAt: process.contractSignedAt,
    };
}

/**
 * Once the contract is signed AND the background check is handled — either a
 * still-valid prior check (bgClearedAt) or fresh consent recorded (bgConsentAt)
 * — advance from EXTERNAL straight to PENDING_PAYMENT. RENEWAL processes take
 * this gate too: a fresh agreement is signed every cycle (beginRenewal), and a
 * still-valid background check arrives here pre-cleared so only the signature
 * is pending. The background check no longer gates payment: when it still needs
 * a human review (no still-valid prior background check), it runs in PARALLEL
 * while the applicant pays, and only the final ACTIVE flip waits on it. A
 * household intake note is shown to the reviewers but does not gate payment.
 *
 * The conditional updateMany (status guard) is the atomic gate: two concurrent
 * callers (Zoho webhook + board "mark bg consent") both reach here, but only the
 * one whose updateMany flips PENDING_EXTERNAL_ACTION sees count === 1 — so the
 * audit row and reviewer ping fire exactly once, and a later status is never
 * regressed. Mirrors review.ts `attest`.
 */
export async function advanceExternalIfComplete(processId: number) {
    const process = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
    if (!process) return process;
    if (process.status !== "PENDING_EXTERNAL_ACTION") return process;
    if (!process.contractSignedAt) return process;
    if (!process.bgClearedAt && !process.bgConsentAt) return process;

    const advanced = await prisma.$transaction(async (tx) => {
        // A household INITIAL/RENEWAL always has a membership (orgMembershipId is
        // only null for PERSON_BG, which never sits at PENDING_EXTERNAL_ACTION).
        const membership = await tx.orgMembership.findUnique({
            where: { id: process.orgMembershipId! },
            select: { householdId: true },
        });
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: {
                id: processId,
                // #7 advance CAS from-state from the definition (#1080); the contract/BG narrowing stays literal.
                ...fromWhere("PENDING_EXTERNAL_ACTION"),
                contractSignedAt: { not: null },
                OR: [{ bgClearedAt: { not: null } }, { bgConsentAt: { not: null } }],
            },
            data: { status: "PENDING_PAYMENT", stageEnteredAt: new Date() },
        });
        if (count !== 1) return null; // lost the race or no longer eligible — no audit, no notify
        // Dues are read at PENDING_PAYMENT (ensurePaymentLink), normally BEFORE the
        // background check clears — so a pre-designated volunteer family must get
        // isVolunteer here, not only at clearance (#874). Sticky + idempotent;
        // clearBackgroundCheck's reviewer-marked pass remains the supplement.
        if (membership) await applyVolunteerStatus(tx, process.orgMembershipId!, membership.householdId, false);
        await tx.auditLog.create({
            data: {
                ...systemActor("system:membership-external-advance"),
                action: "EDIT",
                tableName: "OrgMembershipProcess",
                affectedEntityId: processId,
                oldData: { status: "PENDING_EXTERNAL_ACTION" },
                newData: { status: "PENDING_PAYMENT" },
            },
        });
        return tx.orgMembershipProcess.findUnique({ where: { id: processId } });
    });
    if (!advanced) return prisma.orgMembershipProcess.findUnique({ where: { id: processId } });

    // No valid prior check ⇒ a human review is still needed. Ping the reviewers;
    // the review now proceeds in parallel with payment (log-only until email is configured).
    if (!advanced.bgClearedAt) await notifyReviewers();
    return advanced;
}

/**
 * Record that the membership contract was signed (idempotent), then maybe advance.
 *
 * A PERSON_AGREEMENT completes on the signature alone — it has no membership,
 * no payment and no BG gate — so it flips straight to the terminal ACTIVE in the same
 * conditional write and skips advanceExternalIfComplete entirely (which would deref a
 * null orgMembershipId).
 *
 * A board-recorded signature clears the signer: the request's addressee may never
 * have signed, and the record must not name someone who didn't.
 */
export async function markContractSigned(processId: number, actorId?: number, recordedByBoard = false) {
    const process = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
    if (!process) throw new ExternalError("not_found", "Application not found.");
    const isPersonAgreement = process.kind === "PERSON_AGREEMENT";
    // Conditional on contractSignedAt: null — two concurrent Zoho webhook retries
    // both see null, but only the winner's updateMany flips it (count === 1), so the
    // audit row is written once. A PERSON_AGREEMENT also requires its from-state, so
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

/** Board human-marks that the applicant submitted background-check consent, then maybe advance. */
export async function markBgConsent(processId: number, actorId: number) {
    const process = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
    if (!process) throw new ExternalError("not_found", "Application not found.");
    // Conditional on bgConsentAt: null so concurrent marks write the audit row once.
    await prisma.$transaction(async (tx) => {
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: { id: processId, bgConsentAt: null },
            data: { bgConsentAt: new Date() },
        });
        if (count !== 1) return;
        await tx.auditLog.create({
            data: { actorId, action: "EDIT", tableName: "OrgMembershipProcess", affectedEntityId: processId, newData: { bgConsentAt: true } },
        });
    });
    return advanceExternalIfComplete(processId);
}

/**
 * Applicant self-report that they submitted background-check consent on
 * Averity (#875). Honor-system by design: Averity has no API, so the applicant's
 * own claim records consent the same way a board mark does — through
 * markBgConsent, with the applicant as the audit actor, so a self-reported
 * consent stays distinguishable from a board-confirmed one. The board
 * mark-bg-consent action remains as the backstop. Idempotent (markBgConsent
 * no-ops on a second call), and restricted to a household lead — the person who
 * actually consents on Averity.
 */
export async function selfRecordBgConsent(userId: number): Promise<ExternalStatus> {
    const user = await prisma.person.findUnique({
        where: { id: userId },
        include: {
            household: { include: { orgMembership: { include: { processes: true } } } },
        },
    });
    if (!user) throw new ExternalError("not_found", "Application not found.");
    if (!user.householdId) throw new ExternalError("no_household", "You must create a household first.");
    if (!user.isHouseholdLead && !user.isSysadmin) {
        throw new ExternalError("not_lead", "Only a household lead can confirm background-check consent.");
    }

    const process = latestPendingExternal(user.household?.orgMembership?.processes);
    if (!process) throw new ExternalError("wrong_phase", "No application is awaiting background-check consent.");

    const updated = await markBgConsent(process.id, userId);
    if (!updated) throw new ExternalError("not_found", "Application not found.");
    return getExternalStatus(updated);
}

/**
 * Associate a Zoho signing request id with a process so its webhook can match.
 * Clears zohoActionId: re-pointing the envelope would otherwise leave the old
 * action id paired with the new request, an unsignable mismatch that
 * getOrCreateContractSigningUrl's null-claim repair can't fix (both ids non-null).
 * Nulling the action id restores the claimable envelope-without-action state its
 * claim already handles — the same recovery clearDeadSigningRequest relies on.
 */
export async function setZohoEnvelope(processId: number, requestId: string, actorId: number) {
    const process = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
    if (!process) throw new ExternalError("not_found", "Application not found.");
    const updated = await prisma.orgMembershipProcess.update({ where: { id: processId }, data: { zohoEnvelopeId: requestId, zohoActionId: null, zohoSignerPersonId: null } });
    await prisma.auditLog.create({
        data: { actorId, action: "EDIT", tableName: "OrgMembershipProcess", affectedEntityId: processId, newData: { zohoEnvelopeId: requestId, zohoActionId: null, zohoSignerPersonId: null } },
    });
    return updated;
}

/** Find the process tied to a Zoho request id (for webhook matching); archived processes never match. */
export async function findProcessByEnvelope(requestId: string) {
    return prisma.orgMembershipProcess.findFirst({ where: { zohoEnvelopeId: requestId, ...zohoWebhookMatchable.where } });
}

/**
 * Forget a dead Zoho signing request (declined/expired/recalled) so the next
 * "sign" click creates a fresh one — the applicant's self-serve recovery (#876).
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

    if (!process.contractSignedAt && process.zohoEnvelopeId && config.zohoAvailable()) {
        try {
            const token = await zohoSign.getAccessToken();
            const state = await zohoSign.getRequestStatus(token, process.zohoEnvelopeId);
            if (state === "completed") {
                await markContractSigned(process.id, userId);
            } else if (state === "terminal") {
                // Declined or expired — forget the dead request so contractStarted
                // resets and the next click creates a fresh one (#876).
                await clearDeadSigningRequest(process.id, process.zohoEnvelopeId, userId);
            }
        } catch (e) {
            logger.error(`Zoho status sync failed for process ${process.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    // Re-read: markContractSigned may have flipped contractSignedAt (and advanced the phase).
    const fresh = await prisma.orgMembershipProcess.findUnique({ where: { id: process.id } });
    return fresh ? getExternalStatus(fresh) : null;
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

    const recipientEmail = user.email;
    const recipientName = user.name?.trim() || user.email || "Applicant";
    if (!recipientEmail) throw new ExternalError("not_found", "Your account has no email on file to sign with.");

    const token = await zohoSign.getAccessToken();

    // Create the request once; reuse the stored ids on every later click so the
    // document is never re-generated (only the embed session below is ephemeral).
    let requestId = process.zohoEnvelopeId;
    let actionId = process.zohoActionId;

    // A stored request may be dead — declined by the signer, or expired after
    // CONTRACT_EXPIRATION_DAYS — and Zoho can neither embed nor revive it. Check
    // before reusing (#876): forget dead ids and fall through to the create path
    // below, so the same button self-recovers. Best-effort — if the status read
    // fails, proceed with the stored ids rather than blocking the click (worst
    // case the embed call fails, as it did before this check existed).
    if (requestId && actionId && !process.contractSignedAt) {
        try {
            if ((await zohoSign.getRequestStatus(token, requestId)) === "terminal") {
                await clearDeadSigningRequest(process.id, requestId, userId);
                requestId = null;
                actionId = null;
            }
        } catch (e) {
            logger.warn(`Zoho request-status check failed for membership process ${process.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    if (requestId && !process.contractSignedAt) await assertSignerIs(process.zohoSignerPersonId, userId);

    if (!requestId || !actionId) {
        // Claim before creating: Zoho charges per request, so only the claim's
        // winner ever calls createRequest, and a concurrent click is told to wait
        // instead of paying for an orphan. The claim matches an INCOMPLETE pair
        // (either id null), not just a null envelope: setZohoEnvelope (the legacy
        // admin/email flow) stores an envelope WITHOUT an action id, which can't be
        // embedded, so that state must stay claimable.
        const claim = await prisma.orgMembershipProcess.updateMany({
            where: { id: process.id, zohoSignerPersonId: null, OR: [{ zohoEnvelopeId: null }, { zohoActionId: null }] },
            data: { zohoSignerPersonId: userId },
        });
        if (claim.count === 0) {
            const current = await prisma.orgMembershipProcess.findUnique({ where: { id: process.id } });
            await assertSignerIs(current?.zohoSignerPersonId ?? null, userId);
            requestId = current?.zohoEnvelopeId ?? null;
            actionId = current?.zohoActionId ?? null;
            if (!requestId || !actionId) {
                throw new ExternalError("wrong_phase", "Your signing request is still being prepared. Please try again in a moment.");
            }
            logger.info(`Concurrent signing request for membership process ${process.id}; reusing stored ${requestId}.`);
            return zohoSign.getEmbeddedSignUrl({ token, requestId, actionId, host: config.baseUrl() });
        }

        let created: Awaited<ReturnType<typeof zohoSign.createRequest>>;
        try {
            // Resolved ONCE for this request so the PDF-skip, watermark, and the
            // provider calls below can't disagree if the dev signing-target radio
            // flips mid-flow (signingMockActive also honors BoardSettings.devSigningTarget).
            const signingMock = await signingMockActive();

            // Mock mode never uploads the PDF (its createRequest ignores the bytes), so
            // skip the S3 load that also 503s in dev — an empty placeholder keeps the
            // create/submit calls type-identical. See docs/ops/contract-signing-mock.md.
            let agreement;
            if (signingMock) {
                agreement = { pdf: Buffer.alloc(0), lastPageNo: 0, pageWidth: 0, pageHeight: 0 };
            } else {
                try {
                    agreement = await loadAgreementPdf();
                } catch (e) {
                    if (e instanceof AgreementUnavailableError) {
                        throw new ExternalError("agreement_unavailable", "The membership agreement isn't ready yet. Please check back soon.");
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
            const requestName = `${isProd ? "" : "[DEV TEST — NOT BINDING] "}Membership Agreement — ${recipientName}`;

            // Return the embedded signer to checkin when they finish (Zoho navigates
            // the window to these). signed=1 lets the membership page confirm + refresh.
            const membershipUrl = `${config.baseUrl()}/membership`;
                created = await zohoSign.createRequest({
                token,
                pdf,
                filename: AGREEMENT_FILENAME,
                recipientEmail,
                recipientName,
                requestName,
                expirationDays: CONTRACT_EXPIRATION_DAYS,
                redirectPages: {
                    sign_completed: `${membershipUrl}?signed=1`,
                    sign_success: `${membershipUrl}?signed=1`,
                    sign_declined: `${membershipUrl}?declined=1`,
                    sign_later: membershipUrl,
                },
            });
            await zohoSign.submitRequest({
                token,
                requestId: created.requestId,
                actionId: created.actionId,
                documentId: created.documentId,
                recipientEmail,
                recipientName,
                lastPageNo: agreement.lastPageNo,
                pageWidth: agreement.pageWidth,
                pageHeight: agreement.pageHeight,
                prefill: { PrintedName: recipientName },
            });
        } catch (e) {
            // Release the claim so the next click can retry.
            await prisma.orgMembershipProcess.updateMany({
                where: { id: process.id, zohoSignerPersonId: userId, OR: [{ zohoEnvelopeId: null }, { zohoActionId: null }] },
                data: { zohoSignerPersonId: null },
            });
            throw e;
        }

        const stored = await prisma.orgMembershipProcess.updateMany({
            where: { id: process.id, zohoSignerPersonId: userId },
            data: { zohoEnvelopeId: created.requestId, zohoActionId: created.actionId },
        });
        if (stored.count === 0) {
            throw new ExternalError("wrong_phase", "Signing was reset while your request was being prepared. Please try again.");
        }
        requestId = created.requestId;
        actionId = created.actionId;
        await prisma.auditLog.create({
            data: {
                actorId: userId,
                action: "EDIT",
                tableName: "OrgMembershipProcess",
                affectedEntityId: process.id,
                newData: { zohoEnvelopeId: requestId, zohoActionId: actionId, zohoSignerPersonId: userId },
            },
        });
        logger.info(`Created Zoho signing request ${requestId} for membership process ${process.id}.`);
    }

    return zohoSign.getEmbeddedSignUrl({ token, requestId, actionId, host: config.baseUrl() });
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
