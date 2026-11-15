import { emailBoardMembers } from "@/lib/emailRecipients";
import type { HouseholdRecipient as ScholarshipRecipient } from "@/lib/emailRecipients";
import { parseEmailHeaderList } from "@/lib/emailHeader";
import { sendTemplated } from "@/lib/email-templates/send";
import type { TemplateCtx, TemplateKey } from "@/lib/email-templates/registry";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";

/**
 * Scholarship / payment-plan notification helpers. Callers name a template and
 * fill its tokens; these helpers only resolve recipients / fan out and swallow
 * send/query errors.
 *
 * An applicant receives exactly ONE automatic email: the request
 * acknowledgement (`sendScholarshipAck`, ungated). Board decisions (program
 * approve/deny, membership approve) are communicated manually by the
 * Scholarship Review Team, not by an automated status email — see
 * docs/architecture/PROGRAM_CAPACITY_AND_SCHOLARSHIPS.md §5.
 */

export type { HouseholdRecipient as ScholarshipRecipient } from "@/lib/emailRecipients";
export { resolveHouseholdRecipients as resolveScholarshipRecipients } from "@/lib/emailRecipients";

/** Announce a request to the Scholarship Review Team: configured address list, else all board members. */
export async function notifyReviewTeam<K extends TemplateKey>(key: K, ctx: TemplateCtx<K>, errorLabel: string): Promise<void> {
    try {
        const settings = await prisma.boardSettings.findUnique({ where: { id: 1 }, select: { scholarshipNotifyEmail: true } });
        const list = settings?.scholarshipNotifyEmail ? parseEmailHeaderList(settings.scholarshipNotifyEmail) : null;
        if (list && list.length) {
            await Promise.all(list.map((to) => sendTemplated(key, to, ctx)));
            return;
        }
        await emailBoardMembers(key, ctx, errorLabel); // UNSET (or unparseable) → board is the review team
    } catch (e) {
        logger.error(errorLabel, e);
    }
}

/** ACK — transactional, UNGATED: every resolved recipient. The applicant's only automatic email. */
export async function sendScholarshipAck<K extends TemplateKey>(recipients: ScholarshipRecipient[], key: K, ctx: TemplateCtx<K>): Promise<void> {
    await Promise.all(recipients.map((r) => sendTemplated(key, r.email, ctx)));
}
