import { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { config } from "@/lib/config";
import { postEventTemplate } from "@/lib/email-templates/post-event";
import { LIVE_PERSON } from "@/lib/person/filters";

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
                            where: { isCore: true, person: LIVE_PERSON },
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
                    ...LIVE_PERSON,
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

            const baseUrl = config.baseUrl();
            const eventLink = `${baseUrl}/program-ops/sessions/${event.id}`;

            const emailHtml = postEventTemplate({
                eventName: event.name,
                attendingRsvps,
                actualVisits,
                eventLink
            });

            const success = await sendEmail(
                recipientEmail,
                `Action Required: Confirm Attendance for ${event.name}`,
                emailHtml
            );

            if (success) {
                await prisma.event.update({
                    where: { id: event.id },
                    data: { postEventEmailSent: true }
                });
                emailsSent++;
            }
        }

        // Update cursor to the last fetched event ID
        cursorId = finishedEvents[finishedEvents.length - 1].id;
    }

    return { processedEvents: processedEventsCount, emailsSent };
}
