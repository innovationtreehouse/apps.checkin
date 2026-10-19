import { NextResponse } from "next/server";
import { withCron } from "@/lib/cronAuth";
import prisma from "@/lib/prisma";
import { STATES } from "@/lib/programs/enrollmentState";
import { resolveHouseholdRecipients, emailBoardMembers } from "@/lib/emailRecipients";
import { sendEmail } from "@/lib/email";
import { escapeHtml } from "@/lib/email-templates/base";

/**
 * Non-payment sweep for PENDING_UNPAID enrollments: warns the household at day
 * 1/3/6 and flags day-7+ rows as overdue for the board. The cron NEVER removes
 * anyone — reviewer decision: this is core customer service, and a computer
 * isn't enough here. Removal is a human action, done by the board via the
 * existing program-participants admin surface (`DELETE
 * /api/programs/[id]/participants`), which routes through the hold-ledger
 * release helper in `lib/program/capacity.ts` (see
 * docs/architecture/PROGRAM_CAPACITY_AND_SCHOLARSHIPS.md §3).
 */

/** Warning copy (day 1/3/6) — identical body across all three, only the subject escalates. */
function warningHtml(programName: string): string {
    return `<p>If not paid, your spot in <strong>${escapeHtml(programName)}</strong> may be released by the board. If you need a scholarship or payment plan, request one from the program's page — the Scholarship Review Team will follow up.</p>`;
}

/** Resolve household leads ∪ participant and fan out. No household → nothing to email
 *  (person.householdId is a required column, but stays defensive here since this is
 *  the warning path, not a place to let a missing recipient throw). */
async function notifyHousehold(householdId: number | null | undefined, personId: number, subject: string, html: string): Promise<void> {
    if (!householdId) return;
    const recipients = await resolveHouseholdRecipients(householdId, personId);
    // sendEmail never rejects (failures resolve to `false` and are logged internally) —
    // fire-and-forget fan-out, nothing left to catch here.
    await Promise.all(recipients.map((r) => sendEmail(r.email, subject, html)));
}

interface DigestRow { name: string; programName: string; diffDays: number; }

function digestListItems(rows: DigestRow[]): string {
    return rows.map((r) => `<li>${escapeHtml(r.name)} — ${escapeHtml(r.programName)} (day ${r.diffDays})</li>`).join("");
}

/** One digest per cron run to the board — never per-person — so day-3 and overdue
 *  rows land in front of a human instead of a removal happening unattended. */
async function sendLeadershipDigest(approaching: DigestRow[], overdue: DigestRow[]): Promise<void> {
    if (approaching.length === 0 && overdue.length === 0) return;
    const subject = `Non-payment digest: ${approaching.length} approaching deadline, ${overdue.length} overdue`;
    const html = `<p><strong>Approaching deadline (3+ days unpaid, final warning at day 6)</strong></p>`
        + `<ul>${digestListItems(approaching)}</ul>`
        + `<p><strong>Overdue (7+ days) — action needed: remove the enrollment or contact the household</strong></p>`
        + `<ul>${digestListItems(overdue)}</ul>`;
    await emailBoardMembers(subject, html, "Non-payment leadership digest failed:");
}

export const GET = withCron(async () => {
        const now = new Date();
        const pendingParticipants = await prisma.programParticipant.findMany({
            where: {
                // The 7-day non-payment clock owns exactly PENDING_UNPAID
                // (enrollmentState §3). Its `where` carries isPaymentPlanRequested:false,
                // which is what keeps HOLD_FAILED (req=true) and denied applicants
                // (den≠null, governed by the grace-expiry cron) out of this sweep —
                // a denial never resets pendingSince, so without that they'd be
                // flagged the night after denial.
                ...STATES.PENDING_UNPAID.where,
                pendingSince: { not: null }
            },
            include: {
                person: true,
                program: true
            }
        });

        let overdueCount = 0;
        let warnedCount = 0;
        const approachingDigest: DigestRow[] = [];
        const overdueDigest: DigestRow[] = [];

        for (const record of pendingParticipants) {
            if (!record.pendingSince) continue;

            const diffTime = Math.abs(now.getTime() - record.pendingSince.getTime());
            const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24)); // Calculate total full days

            if (diffDays >= 7) {
                // No longer auto-removed — flagged for the board to act on.
                overdueCount++;
                overdueDigest.push({ name: record.person.name ?? "(no name on file)", programName: record.program.name, diffDays });
            } else if (diffDays === 6 || diffDays === 3 || diffDays === 1) {
                warnedCount++;
                const subject = diffDays === 6
                    ? `FINAL WARNING: 24 hours left to pay for ${record.program.name}`
                    : diffDays === 3
                        ? `Please pay for ${record.program.name} within 4 days`
                        : `Reminder: Payment required for ${record.program.name}`;
                await notifyHousehold(record.person.householdId, record.personId, subject, warningHtml(record.program.name));
                if (diffDays === 3) {
                    approachingDigest.push({ name: record.person.name ?? "(no name on file)", programName: record.program.name, diffDays });
                }
            }
        }

        await sendLeadershipDigest(approachingDigest, overdueDigest);

        return NextResponse.json({ success: true, processed: pendingParticipants.length, warned: warnedCount, overdue: overdueCount });
});
