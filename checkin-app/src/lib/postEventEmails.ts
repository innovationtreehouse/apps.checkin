import { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";
import { config } from "@/lib/config";
import { sendTemplated } from "@/lib/email-templates/send";
import { logIntegrationError } from "@/lib/logger";

/** Failed sends of one event's email before the runs give up and tell the Board. */
export const POST_EVENT_EMAIL_MAX_ATTEMPTS = 5;

/** A claim this old belongs to a run that crashed mid-send, so another run may take it over. */
const CLAIM_STALE_AFTER_MS = 15 * 60_000;

interface ProcessPostEventEmailsOptions {
    /**
     * If true, bypasses the 1-hour wait period and processes any events that have already ended.
     * Useful for facility close or nightly cron where we want to forcefully wrap up the day.
     */
    forceImmediate?: boolean;
    /**
     * Number of emails to process in a single database batch query.
     */
    batchSize?: number;
}

/**
 * Sweeps the database for finished events that haven't had their confirmation emails sent
 * to the program lead. By default, it waits 1 hour after the event ends to ensure all
 * attendance data has settled.
 */
export async function processPostEventEmails(options: ProcessPostEventEmailsOptions = {}) {
    const { forceImmediate = false, batchSize = 50 } = options;
    const now = new Date();
    
    // Determine the cutoff time based on the forceImmediate flag
    const cutoffTime = forceImmediate ? now : new Date(now.getTime() - 1 * 60 * 60 * 1000);

    let emailsSent = 0;
    let processedEventsCount = 0;
    let cursorId: number | undefined = undefined;

    while (true) {
        // Find events that have ended before the cutoff, haven't had an email sent yet, and attendance is not confirmed.
        const whereClause: Prisma.EventWhereInput = {
            endAt: { lte: cutoffTime },
            postEventEmailSent: false,
            postEventEmailAttempts: { lt: POST_EVENT_EMAIL_MAX_ATTEMPTS },
            attendanceConfirmedAt: null,
            programId: { not: null },
            ...(cursorId ? { id: { gt: cursorId } } : {})
        };

        const finishedEvents = await prisma.event.findMany({
            where: whereClause,
            include: {
                program: {
                    include: {
                        volunteers: {
                            where: { isCore: true },
                            include: { person: true }
                        }
                    }
                },
                rsvps: true,
                visits: { where: { deletedAt: null } }
            },
            take: batchSize,
            orderBy: { id: 'asc' }
        });

        if (finishedEvents.length === 0) {
            break;
        }

        // Extract unique lead mentor IDs
        const leadMentorIds = Array.from(new Set(
            finishedEvents
                .map(event => event.program?.leadMentorId)
                .filter((id): id is number => id !== null && id !== undefined)
        ));

        // Batch fetch all lead mentors at once
        const leadMentorsMap = new Map<number, string | null>();
        if (leadMentorIds.length > 0) {
            const leadMentors = await prisma.person.findMany({
                where: {
                    id: { in: leadMentorIds },
                },
                select: {
                    id: true,
                    email: true
                }
            });
            for (const lead of leadMentors) {
                leadMentorsMap.set(lead.id, lead.email);
            }
        }

        for (const event of finishedEvents) {
            processedEventsCount++;
            const program = event.program;
            if (!program) continue;

            const leadMentorId = program.leadMentorId;
            let recipientEmail: string | null | undefined = null;

            if (leadMentorId) {
                recipientEmail = leadMentorsMap.get(leadMentorId);
            } else {
                // Try to fallback to a core volunteer
                const coreVolunteer = program.volunteers[0]?.person;
                recipientEmail = coreVolunteer?.email;
            }

            if (!recipientEmail) {
                console.log(`No recipient found for post-event email for event ${event.id}`);
                continue; // Can't send email if we don't know who to send it to
            }

            const attendingRsvps = event.rsvps.filter(r => r.status === 'ATTENDING').length;
            const actualVisits = event.visits.length;

            // Overlapping runs (the crons and facility close) read the same unsent
            // event; only the run whose conditional write lands may send it.
            const claimedAt = new Date();
            const claim = await prisma.event.updateMany({
                where: {
                    id: event.id,
                    postEventEmailSent: false,
                    postEventEmailAttempts: { lt: POST_EVENT_EMAIL_MAX_ATTEMPTS },
                    OR: [
                        { postEventEmailClaimedAt: null },
                        { postEventEmailClaimedAt: { lt: new Date(claimedAt.getTime() - CLAIM_STALE_AFTER_MS) } },
                    ],
                },
                data: { postEventEmailClaimedAt: claimedAt },
            });
            if (claim.count !== 1) continue;

            const baseUrl = config.baseUrl();
            const eventLink = `${baseUrl}/program-ops/sessions/${event.id}`;

            const success = await sendTemplated("event.postEvent", recipientEmail, {
                eventName: event.name,
                rsvpCount: String(attendingRsvps),
                checkinCount: String(actualVisits),
                actionLink: eventLink,
            });

            if (success) {
                await prisma.event.update({
                    where: { id: event.id },
                    data: { postEventEmailSent: true }
                });
                emailsSent++;
                continue;
            }

            // Release the claim so the next run retries now, not after the stale window.
            await prisma.event.updateMany({
                where: { id: event.id, postEventEmailClaimedAt: claimedAt },
                data: { postEventEmailClaimedAt: null, postEventEmailAttempts: { increment: 1 } },
            });
            const attempts = event.postEventEmailAttempts + 1;
            if (attempts >= POST_EVENT_EMAIL_MAX_ATTEMPTS) {
                await logIntegrationError(
                    "post-event-email",
                    `Post-event email for "${event.name}" (event ${event.id}) failed ${attempts} times; no more attempts. Remind the program lead to confirm attendance.`,
                    { eventId: event.id },
                );
            }
        }

        // Update cursor to the last fetched event ID
        cursorId = finishedEvents[finishedEvents.length - 1].id;
    }

    return { processedEvents: processedEventsCount, emailsSent };
}
