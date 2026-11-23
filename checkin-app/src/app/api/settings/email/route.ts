import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { apiError } from "@/lib/api-response";
import { isValidEmailHeader, parseEmailHeaderList } from "@/lib/emailHeader";
import { isValidEmail } from "@/lib/emergencyContacts/identity";
import { handler } from "@/security/handler";
import { personActor, recordAudit } from "@/lib/auditActor";
import { readTemplateFields, unknownTokenError, writeTemplateFields, type FieldTargets } from "@/lib/email-templates/settingsFields";

export const dynamic = "force-dynamic";

const SELECT = {
    emailFromAddress: true,
    emailReplyToAddress: true,
    scholarshipNotifyEmail: true,
    financeAlertEmailAddress: true,
    boardEmailAddress: true,
    sysadminEmailAddress: true,
    bgReviewerEmailAddress: true,
    financeContactEmail: true,
    scholarshipAckSubject: true,
    scholarshipAckMembershipBody: true,
    scholarshipAckProgramBody: true,
} as const;

const ACK_BODY_MAX_LEN = 5000;

const ADDRESS_FIELDS = ["financeAlertEmailAddress", "boardEmailAddress", "sysadminEmailAddress", "bgReviewerEmailAddress", "financeContactEmail"] as const;

type AckField = "scholarshipAckSubject" | "scholarshipAckMembershipBody" | "scholarshipAckProgramBody";
const ACK_TARGETS: FieldTargets<AckField> = {
    scholarshipAckSubject: [
        { key: "scholarship.ackMembership", part: "subject" },
        { key: "scholarship.ackProgram", part: "subject" },
        { key: "scholarship.ackProgramHoldFailed", part: "subject" },
    ],
    scholarshipAckMembershipBody: [{ key: "scholarship.ackMembership", part: "body" }],
    scholarshipAckProgramBody: [{ key: "scholarship.ackProgram", part: "body" }],
};

/** The sender settings, with the ACK copy read from its `EmailTemplate` rows. */
async function readSettings() {
    const settings = await prisma.boardSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {}, select: SELECT });
    return { ...settings, ...(await readTemplateFields(ACK_TARGETS)) };
}

/** GET /api/settings/email — outbound-email sender identity (BoardSettings singleton).
 *  Registry-governed: admission anyRole sysadmin/board; envelope 'settings'.
 *  The narrow SELECT stays as defense in depth. */
export const GET = handler('GET /api/settings/email', async () => {
    return { BoardSettings: await readSettings() };
});

/**
 * PUT /api/settings/email — set the Resend From override, Reply-To, the
 * Scholarship Review Team notify address, the finance alert, Board, sysadmin and
 * background-check reviewer group addresses, the finance contact address, and the scholarship ACK subject/bodies (saved to their
 * `EmailTemplate` rows and their BoardSettings columns; the subject is all three ACK rows').
 * Body may include emailFromAddress, emailReplyToAddress, scholarshipNotifyEmail,
 * financeAlertEmailAddress, boardEmailAddress, sysadminEmailAddress, bgReviewerEmailAddress,
 * financeContactEmail (string|null), scholarshipAckSubject, scholarshipAckMembershipBody, and
 * scholarshipAckProgramBody. emailFromAddress is a single address shape (bare or
 * `Name <addr@domain>`). scholarshipNotifyEmail/emailReplyToAddress may be a
 * comma-separated list of one or more addresses, each in that same shape (e.g.
 * "info@x.org, ops@x.org") — replies can fan out to more than one inbox.
 * The five group and contact addresses are each one bare address. financeAlertEmailAddress
 * also writes alertEmailAddress, the column the senders read. The ACK
 * subject/bodies are plain text (HTML-escaped when sent, not interpreted as markup) capped at
 * ACK_BODY_MAX_LEN chars. A malformed value rejects the whole update (400) so the
 * previous value survives. Blank/empty clears back to null (env default From; no
 * Reply-To; default ACK copy). The From must be on a Resend-verified domain to
 * actually deliver.
 */
export const PUT = withAuth({ roles: ["isSysadmin", "isBoardMember"] }, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    let body: {
        emailFromAddress?: string | null;
        emailReplyToAddress?: string | null;
        scholarshipNotifyEmail?: string | null;
        financeAlertEmailAddress?: string | null;
        boardEmailAddress?: string | null;
        sysadminEmailAddress?: string | null;
        bgReviewerEmailAddress?: string | null;
        financeContactEmail?: string | null;
        scholarshipAckSubject?: string | null;
        scholarshipAckMembershipBody?: string | null;
        scholarshipAckProgramBody?: string | null;
    };
    try {
        body = await req.json();
    } catch {
        return apiError("Invalid JSON", 400);
    }

    const data: Record<string, string | null> = {};
    if (body.emailFromAddress !== undefined) {
        const from = body.emailFromAddress?.trim();
        if (from && !isValidEmailHeader(from)) return apiError("emailFromAddress must be an email address or \"Name <addr@domain>\"", 400);
        data.emailFromAddress = from || null;
    }
    if (body.emailReplyToAddress !== undefined) {
        const replyTo = body.emailReplyToAddress?.trim();
        if (replyTo && !parseEmailHeaderList(replyTo)) {
            return apiError("emailReplyToAddress must be a comma-separated list of email addresses (each an address or \"Name <addr@domain>\")", 400);
        }
        data.emailReplyToAddress = replyTo || null;
    }
    if (body.scholarshipNotifyEmail !== undefined) {
        const v = body.scholarshipNotifyEmail?.trim();
        if (v && !parseEmailHeaderList(v)) {
            return apiError("scholarshipNotifyEmail must be a comma-separated list of email addresses (each an address or \"Name <addr@domain>\")", 400);
        }
        data.scholarshipNotifyEmail = v || null; // blank clears to null
    }
    for (const field of ADDRESS_FIELDS) {
        if (body[field] === undefined) continue;
        const v = body[field]?.trim();
        if (v && !isValidEmail(v)) return apiError(`${field} must be an email address`, 400);
        data[field] = v || null;
    }
    if (data.financeAlertEmailAddress !== undefined) data.alertEmailAddress = data.financeAlertEmailAddress;
    if (body.scholarshipAckSubject !== undefined) {
        const v = body.scholarshipAckSubject?.trim();
        if (v && v.length > ACK_BODY_MAX_LEN) return apiError(`scholarshipAckSubject must be ${ACK_BODY_MAX_LEN} characters or fewer`, 400);
        data.scholarshipAckSubject = v || null;
    }
    if (body.scholarshipAckMembershipBody !== undefined) {
        const v = body.scholarshipAckMembershipBody?.trim();
        if (v && v.length > ACK_BODY_MAX_LEN) return apiError(`scholarshipAckMembershipBody must be ${ACK_BODY_MAX_LEN} characters or fewer`, 400);
        data.scholarshipAckMembershipBody = v || null;
    }
    if (body.scholarshipAckProgramBody !== undefined) {
        const v = body.scholarshipAckProgramBody?.trim();
        if (v && v.length > ACK_BODY_MAX_LEN) return apiError(`scholarshipAckProgramBody must be ${ACK_BODY_MAX_LEN} characters or fewer`, 400);
        data.scholarshipAckProgramBody = v || null;
    }

    const { scholarshipAckSubject, scholarshipAckMembershipBody, scholarshipAckProgramBody } = data;
    const ack = { scholarshipAckSubject, scholarshipAckMembershipBody, scholarshipAckProgramBody };
    const tokenError = unknownTokenError(ACK_TARGETS, ack);
    if (tokenError) return apiError(tokenError, 400);

    await prisma.$transaction(async (tx) => {
        await tx.boardSettings.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data, select: SELECT });
        await writeTemplateFields(tx, ACK_TARGETS, ack, auth.user.id);
        await recordAudit(tx, personActor(auth.user.id), {
            action: "EDIT",
            tableName: "BoardSettings",
            affectedEntityId: 1,
            newData: data,
        });
    });
    const settings = await readSettings();

    return NextResponse.json({ settings });
});
