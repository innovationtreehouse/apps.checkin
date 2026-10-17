import prisma from "./prisma";
import { sendEmail } from "./email";
import { runPaced } from "./email";
import { formatTime, formatDate } from "./time";
import { resolveDisplayTimezone } from "./appSettings";
import { checkinReceiptTemplate } from "./email-templates/checkin";
import { householdMemberTemplate } from "./email-templates/household";
import { escapeHtml, type VisitSource } from "./email-templates/base";
import { programAssignmentTemplate } from "./email-templates/program-assignment";
import { config } from "./config";
import { LIVE_PERSON } from "./person/filters";
import {
    ACTIVE_ORG_MEMBER_PERSON_WHERE,
    isActiveOrgMemberThrough,
    programCoverageDate,
} from "./orgMembership";

/**
 * Service to handle sending notifications to users via their defined preferences.
 */

export type NotificationEvent =
    | 'PROGRAM_ENROLLMENT'
    | 'PROGRAM_ASSIGNMENT'
    | 'CHECKIN'
    | 'CHECKOUT';

/**
 * @returns true if delivery succeeded or there was nothing to send (don't retry),
 *          false if the send failed (caller should retry).
 */
export async function sendNotification(userId: number, eventType: NotificationEvent, payload: Record<string, unknown>): Promise<boolean> {
    try {
        const user = await prisma.person.findUnique({
            where: { id: userId },
            select: { email: true, notificationSettings: true, name: true }
        });

        // No user / no address: nothing can ever be sent here — treat as done, not retryable.
        if (!user || !user.email) return true;

        // Construct message based on type. `html`, when set, is sent verbatim as the
        // email body (already-safe HTML from a template); otherwise `message` is
        // escaped and wrapped in a <p>.
        let message = "";
        let subject = "Treehouse Notification";
        let html: string | null = null;

        switch (eventType) {
            case 'PROGRAM_ENROLLMENT':
                subject = `Confirmed: Enrollment in ${payload.programName}`;
                message = `Hi ${user.name}, you have been successfully enrolled in ${payload.programName}.`;
                break;
            case 'PROGRAM_ASSIGNMENT':
                subject = 'Your Innovation Treehouse Program has been Created!';
                html = programAssignmentTemplate({
                    programName: String(payload.programName ?? 'your program'),
                    manageUrl: `${config.baseUrl()}/program-ops/programs/${payload.programId}`,
                });
                break;
            case 'CHECKIN':
                subject = `✅ Checked In — ${user.name}`;
                message = `Hi ${user.name}, you arrived at Innovation Treehouse at ${payload.time}.`;
                break;
            case 'CHECKOUT':
                subject = `👋 Checked Out — ${user.name}`;
                message = `Hi ${user.name}, you departed Innovation Treehouse at ${payload.time}.`;
                break;
            default:
                message = `System Action: ${eventType}`;
        }

        // Check user preferences
        const settings = user.notificationSettings as unknown as Record<string, boolean>;
        const wantsEmail = settings?.email !== false; // Active by default

        // Email disabled: return true so a user who opted out isn't retried forever.
        if (!wantsEmail) return true;

        const ok = await sendEmail(user.email, subject, html ?? `<p>${escapeHtml(message)}</p>`);
        return ok;

    } catch (error) {
        console.error("Failed to sequence notification:", error);
        return false;
    }
}

/**
 * Broadcast a "new program announced" email to members whose household membership
 * covers the program's FULL DURATION (#1061 rule, reused verbatim), respecting each
 * person's notifyNewPrograms / email prefs (default ON). Paced at 5/sec (#1154).
 *
 * The single gate is maybeAnnounceOnOpen in @/lib/programAnnounce — it owns the
 * announceOnOpen opt-in, the transition rule, and the once-per-lifetime announcedAt
 * claim, and both program-edit PATCH routes call it. This only runs after that gate
 * has fired. Best-effort: fire-and-forget from the helper.
 */
export async function notifyNewProgramAnnounced(
    program: { name: string; endAt: Date },
): Promise<void> {
    try {
        const coverageDate = programCoverageDate(program);

        // Narrow to LIVE persons with an address in an ACTIVE-membership household
        // (canonical ACTIVE_ORG_MEMBER_PERSON_WHERE). Class-1 person.findMany with
        // LIVE_PERSON — drift guard stays green, no allowlist (human-facing).
        const users = await prisma.person.findMany({
            where: { email: { not: null }, ...LIVE_PERSON, ...ACTIVE_ORG_MEMBER_PERSON_WHERE },
            select: { id: true, email: true, name: true, notificationSettings: true },
        });

        const subject = `New program: ${program.name}`;
        const tasks: Array<() => Promise<boolean>> = [];
        for (const u of users) {
            if (!u.email) continue;
            const s = u.notificationSettings as unknown as Record<string, boolean> | null;
            if (s?.notifyNewPrograms === false) continue; // opted out of this notice
            if (s?.email === false) continue;              // opted out of all email
            // ponytail: reuse isActiveOrgMemberThrough verbatim (#1061 — one definition of
            // "covered for the program year"). N indexed reads over the active-member set;
            // fires once per program, fire-and-forget — fine. If the member base grows,
            // dedupe the horizon per householdId via membershipValidThrough.
            if (!(await isActiveOrgMemberThrough(u.id, coverageDate))) continue;
            const email = u.email;
            const name = u.name;
            const message = `Hi ${name}, a new program "${program.name}" is now open for enrollment.`;
            tasks.push(() => sendEmail(email, subject, `<p>${escapeHtml(message)}</p>`));
        }

        await runPaced(tasks);
    } catch (error) {
        console.error("Failed to send new-program notifications:", error);
    }
}

/**
 * Send check-in/out notifications based on user & household preferences.
 * 
 * Handles two notification settings:
 * - emailCheckinReceipts: send to the participant themselves
 * - emailDependentCheckins: send to household leads when a dependent checks in/out
 */
export async function sendCheckinNotifications(participantId: number, type: 'checkin' | 'checkout', source?: VisitSource | null, at: Date = new Date()) {
    try {
        const participant = await prisma.person.findUnique({
            where: { id: participantId },
            select: {
                id: true,
                name: true,
                email: true,
                notificationSettings: true,
                householdId: true,
            }
        });

        if (!participant) return;

        // Server-side render: the client TimezoneProvider never runs here, so the
        // configured zone is passed per call.
        const timeZone = await resolveDisplayTimezone();
        const timeStr = formatTime(at, {
            timeZone,
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
        });
        const dateStr = formatDate(at, {
            timeZone,
            weekday: 'long',
            month: 'long',
            day: 'numeric'
        });

        const action = type === 'checkin' ? 'checked in to' : 'checked out of';
        const emoji = type === 'checkin' ? '✅' : '👋';
        const name = participant.name || 'A member';

        const emailPromises: Promise<unknown>[] = [];

        // 1. Send receipt to the participant themselves if they opted in
        const settings = participant.notificationSettings as unknown as Record<string, boolean>;
        if (settings?.emailCheckinReceipts && participant.email) {
            const subject = `${emoji} ${name} ${action} Innovation Treehouse`;
            const html = checkinReceiptTemplate({ name, type, date: dateStr, time: timeStr, source });
            emailPromises.push(sendEmail(participant.email, subject, html));
        }

        // 2. Notify household leads if the participant is in a household
        if (participant.householdId) {
            const householdLeads = await prisma.person.findMany({
                where: { householdId: participant.householdId, isHouseholdLead: true, ...LIVE_PERSON },
                select: {
                    id: true,
                    email: true,
                    name: true,
                    notificationSettings: true
                }
            });

            for (const lead of householdLeads) {
                // Don't double-notify if the lead IS the participant
                if (lead.id === participant.id) continue;

                const leadSettings = lead.notificationSettings as unknown as Record<string, boolean>;
                if (leadSettings?.emailDependentCheckins && lead.email) {
                    const subject = `${emoji} ${name} ${action} Innovation Treehouse`;
                    const html = householdMemberTemplate({
                        leadName: lead.name || 'there',
                        memberName: name,
                        type,
                        date: dateStr,
                        time: timeStr,
                        source
                    });
                    emailPromises.push(sendEmail(lead.email, subject, html));
                }
            }
        }

        if (emailPromises.length > 0) {
            await Promise.all(emailPromises);
        }

    } catch (error) {
        console.error("Failed to send checkin notifications:", error);
    }
}
