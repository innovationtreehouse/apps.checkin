import prisma from "./prisma";
import { runPaced } from "./email";
import { formatTime, formatDate } from "./time";
import { resolveDisplayTimezone } from "./appSettings";
import { sourceLine, type VisitSource } from "./email-templates/base";
import { sendTemplated } from "./email-templates/send";
import { config } from "./config";
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
    | 'PROGRAM_ASSIGNMENT';

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

        // Check user preferences
        const settings = user.notificationSettings as unknown as Record<string, boolean>;
        const wantsEmail = settings?.email !== false; // Active by default

        // Email disabled: return true so a user who opted out isn't retried forever.
        if (!wantsEmail) return true;

        if (eventType === 'PROGRAM_ENROLLMENT') {
            return await sendTemplated('enrollment.confirm', user.email, {
                name: user.name ?? '',
                programName: String(payload.programName),
            });
        }
        return await sendTemplated('program.assignment', user.email, {
            programName: String(payload.programName ?? 'your program'),
            actionLink: `${config.baseUrl()}/program-ops/programs/${payload.programId}`,
        });

    } catch (error) {
        console.error("Failed to sequence notification:", error);
        return false;
    }
}

/**
 * Broadcast a "new program announced" email to members whose household membership
 * covers the program's FULL DURATION (the isActiveOrgMemberThrough rule), respecting each
 * person's notifyNewPrograms / email prefs (default ON). Paced at 5/sec.
 *
 * The single gate is maybeAnnounceOnOpen in @/lib/programAnnounce — it owns the
 * announceOnOpen opt-in, the transition rule, and the once-per-lifetime announcedAt
 * claim, and both program-edit PATCH routes call it. This only runs after that gate
 * has fired. Best-effort: fire-and-forget from the helper.
 */
export async function notifyNewProgramAnnounced(
    program: { name: string; endAt: Date; appliesToYear: number },
): Promise<void> {
    try {
        const coverageDate = await programCoverageDate(program);

        // Narrow to persons with an address in an ACTIVE-membership household
        // (canonical ACTIVE_ORG_MEMBER_PERSON_WHERE).
        const users = await prisma.person.findMany({
            where: { email: { not: null }, ...ACTIVE_ORG_MEMBER_PERSON_WHERE },
            select: { id: true, email: true, name: true, notificationSettings: true },
        });

        const tasks: Array<() => Promise<boolean>> = [];
        for (const u of users) {
            if (!u.email) continue;
            const s = u.notificationSettings as unknown as Record<string, boolean> | null;
            if (s?.notifyNewPrograms === false) continue; // opted out of this notice
            if (s?.email === false) continue;              // opted out of all email
            // ponytail: reuse isActiveOrgMemberThrough verbatim (one definition of
            // "covered for the program year"). N indexed reads over the active-member set;
            // fires once per program, fire-and-forget — fine. If the member base grows,
            // dedupe the horizon per householdId via membershipValidThrough.
            if (!(await isActiveOrgMemberThrough(u.id, coverageDate))) continue;
            const email = u.email;
            const name = u.name ?? "";
            tasks.push(() => sendTemplated("program.announced", email, { name, programName: program.name }));
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
        const via = sourceLine(source);

        const emailPromises: Promise<unknown>[] = [];

        // 1. Send receipt to the participant themselves if they opted in
        const settings = participant.notificationSettings as unknown as Record<string, boolean>;
        if (settings?.emailCheckinReceipts && participant.email) {
            emailPromises.push(sendTemplated('checkin.receipt', participant.email, {
                name,
                emoji,
                visitWord: type === 'checkin' ? 'Started' : 'Ended',
                action,
                date: dateStr,
                time: timeStr,
                via,
            }));
        }

        // 2. Notify household leads if the participant is in a household
        if (participant.householdId) {
            const householdLeads = await prisma.person.findMany({
                where: { householdId: participant.householdId, isHouseholdLead: true },
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
                    emailPromises.push(sendTemplated('checkin.householdMember', lead.email, {
                        leadName: lead.name || 'there',
                        memberName: name,
                        emoji,
                        arrivalWord: type === 'checkin' ? 'Arrival' : 'Departure',
                        action,
                        date: dateStr,
                        time: timeStr,
                        via,
                    }));
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
