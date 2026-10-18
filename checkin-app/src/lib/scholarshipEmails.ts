import { sendEmail } from "@/lib/email";
import { emailBoardMembers } from "@/lib/emailRecipients";
import type { HouseholdRecipient as ScholarshipRecipient } from "@/lib/emailRecipients";
import { parseEmailHeaderList } from "@/lib/emailHeader";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { DEFAULT_ACK_SUBJECT, DEFAULT_ACK_MEMBERSHIP_BODY, DEFAULT_ACK_PROGRAM_BODY, renderAckBody } from "@/lib/scholarshipAckCopy";
export { DEFAULT_ACK_SUBJECT, DEFAULT_ACK_MEMBERSHIP_BODY, DEFAULT_ACK_PROGRAM_BODY, renderAckBody };

/**
 * Scholarship / payment-plan notification helpers. Small, dependency-light
 * (prisma + email + emailRecipients + emailHeader + logger only), mirroring
 * the contract of emailRecipients.ts: callers build their own subject/html;
 * these helpers only resolve recipients / gate / fan out and swallow
 * send/query errors.
 *
 * An applicant receives exactly ONE automatic email: the request
 * acknowledgement (`sendScholarshipAck`, ungated). Board decisions (program
 * approve/deny, membership approve) are communicated manually by the
 * Scholarship Review Team, not by an automated status email — see
 * docs/architecture/PROGRAM_CAPACITY_AND_SCHOLARSHIPS.md §5.
 */

type AckSettings = {
    scholarshipAckSubject?: string | null;
    scholarshipAckMembershipBody?: string | null;
    scholarshipAckProgramBody?: string | null;
} | null | undefined;

/**
 * Resolve the ACK subject + body for one send variant, falling back to the
 * default copy when the configured value is unset or blank/whitespace.
 * `variant: "membership"` renders no tokens; `"program"` substitutes
 * `{{programName}}`. Callers needing the hard-coded Shopify-failure copy
 * build that body themselves — it deliberately bypasses this resolver.
 */
export function resolveAckCopy(
    settings: AckSettings,
    variant: "membership" | "program",
    vars: { programName?: string } = {},
): { subject: string; body: string } {
    const subjectRaw = settings?.scholarshipAckSubject?.trim();
    // Mirrors renderAckBody's {{programName}} fallback (?? ""); subject is plain text, no HTML escaping.
    const subject = (subjectRaw || DEFAULT_ACK_SUBJECT).replaceAll("{{programName}}", vars.programName ?? "");

    const bodyTemplateRaw = variant === "membership" ? settings?.scholarshipAckMembershipBody : settings?.scholarshipAckProgramBody;
    const bodyTemplate = bodyTemplateRaw?.trim()
        ? bodyTemplateRaw
        : (variant === "membership" ? DEFAULT_ACK_MEMBERSHIP_BODY : DEFAULT_ACK_PROGRAM_BODY);

    return { subject, body: renderAckBody(bodyTemplate, vars) };
}

export type { HouseholdRecipient as ScholarshipRecipient } from "@/lib/emailRecipients";
export { resolveHouseholdRecipients as resolveScholarshipRecipients } from "@/lib/emailRecipients";

/** Announce a request to the Scholarship Review Team: configured address list, else all board members. */
export async function notifyReviewTeam(subject: string, html: string, errorLabel: string): Promise<void> {
    try {
        const settings = await prisma.boardSettings.findUnique({ where: { id: 1 }, select: { scholarshipNotifyEmail: true } });
        const list = settings?.scholarshipNotifyEmail ? parseEmailHeaderList(settings.scholarshipNotifyEmail) : null;
        if (list && list.length) {
            await Promise.all(list.map((to) => sendEmail(to, subject, html)));
            return;
        }
        await emailBoardMembers(subject, html, errorLabel); // UNSET (or unparseable) → board is the review team
    } catch (e) {
        logger.error(errorLabel, e);
    }
}

/** ACK — transactional, UNGATED: every resolved recipient. The applicant's only automatic email. */
export async function sendScholarshipAck(recipients: ScholarshipRecipient[], subject: string, html: string): Promise<void> {
    await Promise.all(recipients.map((r) => sendEmail(r.email, subject, html)));
}
