import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { addDays, parseISO, isBefore, isEqual, getDay, setHours, setMinutes } from 'date-fns';
import { fromZonedTime } from 'date-fns-tz';
import { getAppSettings } from "@/lib/appSettings";
import { apiError } from "@/lib/api-response";
import { handler } from "@/security/handler";

// List standalone (one-time) events — those with no associated program.
// Registry-governed (GET /api/events): admission anyRole sysadmin/board;
// envelope null + single-key bag keeps the bare-array response shape. The
// select stays tight (all public-tier columns) as defense in depth.
export const GET = handler('GET /api/events', async () => {
    const events = await prisma.event.findMany({
        where: { programId: null },
        orderBy: { startAt: "desc" },
        select: { id: true, name: true, startAt: true, endAt: true, description: true },
    });
    return { Event: events };
});

export const POST = withAuth({}, async (req, auth) => {
    if (auth.type !== 'session') return apiError("Unauthorized", 401);

    try {
        const body = await req.json();
        const { name, description, programId, startDate, startTime, endTime, recurrence } = body;

        if (!name || !startDate || !startTime || !endTime) {
            return apiError("Missing required fields", 400);
        }

        const user = auth.user;
        const isSysAdminOrBoard = user.isSysadmin || user.isBoardMember;
        let isLeadMentor = false;

        if (programId) {
            const currentProgram = await prisma.program.findUnique({ where: { id: parseInt(programId, 10) } });
            if (currentProgram && currentProgram.leadMentorId === user.id) {
                isLeadMentor = true;
            }
        }

        if (!isSysAdminOrBoard && !isLeadMentor) {
            return apiError("Forbidden: Not authorized to create events", 403);
        }

        // Wall-clock times are entered in the org's local timezone; convert to UTC against it.
        const { timezone } = await getAppSettings();

        // Parse baseline dates
        const baseDateString = startDate.includes("T") ? startDate.split("T")[0] : startDate; // YYYY-MM-DD

        // Use fromZonedTime so that "15:00" maps to the org timezone precisely rather than rolling to UTC
        let currentIterDate = parseISO(baseDateString);

        const [startHr, startMin] = startTime.split(':').map(Number);
        const [endHr, endMin] = endTime.split(':').map(Number);

        // Each event (single or recurring) spans one day's wall-clock window, so
        // compare time-of-day once here rather than per-iteration. End must be after start.
        if (endHr * 60 + endMin <= startHr * 60 + startMin) {
            return apiError("Event end time must be after start time", 400);
        }

        const eventsToCreate = [];

        if (!recurrence || !recurrence.daysOfWeek || recurrence.daysOfWeek.length === 0 || !recurrence.until) {
            // Single event
            // Create naive local date then cast it as the org timezone so node uses that offset before converting to UTC.
            const startLocal = setMinutes(setHours(currentIterDate, startHr), startMin);
            const endLocal = setMinutes(setHours(currentIterDate, endHr), endMin);

            const startD = fromZonedTime(startLocal, timezone);
            const endD = fromZonedTime(endLocal, timezone);

            eventsToCreate.push({
                name,
                description: description || null,
                programId: programId ? parseInt(programId, 10) : null,
                startAt: startD,
                endAt: endD
            });
        } else {
            // Recurring events
            const untilDate = parseISO(recurrence.until.includes("T") ? recurrence.until.split("T")[0] : recurrence.until);
            // Limit recurrence to 365 days maximum to prevent infinite loop errors
            let loopGuard = 0;
            const recurringGroupId = crypto.randomUUID();

            while ((isBefore(currentIterDate, untilDate) || isEqual(currentIterDate, untilDate)) && loopGuard < 365) {
                const dayOfWeek = getDay(currentIterDate); // 0 = Sun, 1 = Mon ...

                if (recurrence.daysOfWeek.includes(dayOfWeek)) {
                    const startLocal = setMinutes(setHours(currentIterDate, startHr), startMin);
                    const endLocal = setMinutes(setHours(currentIterDate, endHr), endMin);

                    const startD = fromZonedTime(startLocal, timezone);
                    const endD = fromZonedTime(endLocal, timezone);

                    eventsToCreate.push({
                        name,
                        description: description || null,
                        programId: programId ? parseInt(programId, 10) : null,
                        startAt: startD,
                        endAt: endD,
                        recurringGroupId
                    });
                }

                currentIterDate = addDays(currentIterDate, 1);
                loopGuard++;
            }
        }

        if (eventsToCreate.length === 0) {
            return apiError("No events generated from constraints.", 400);
        }

        const insertedEvents = await prisma.event.createMany({
            data: eventsToCreate
        });

        // We don't individually audit log massive lists in bulk.
        // We log the action summary.
        await prisma.auditLog.create({
            data: {
                actorId: user.id,
                action: 'CREATE',
                tableName: 'Event',
                affectedEntityId: programId ? parseInt(programId) : 0,
                newData: { count: insertedEvents.count, sample: eventsToCreate[0] }
            }
        });

        return NextResponse.json({ success: true, count: insertedEvents.count });
    } catch (error: unknown) {
        logger.error("Event creation error:", error);
        return apiError("Failed to create event(s)", 500);
    }
});
