/**
 * @jest-environment node
 */
/**
 * Leaving a program, by withdrawal or removal, deletes the person's RSVPs for
 * its events that have not started. RSVPs for started events, other programs,
 * and people who also volunteer stay. The lead's tally counts a participant's
 * RSVP only while they are enrolled.
 */

import { deleteAndReleaseHold, withdrawParticipant } from '@/lib/program/capacity';
import { todoCounts } from '@/lib/nav/todoCounts';
import type { AuthenticatedUser } from '@/types/auth';
import prisma from '@/lib/prisma';

const TAG = 'withdraw-rsvp-test';
const HOUR = 60 * 60 * 1000;

describe('leaving a program clears future RSVPs', () => {
    let leadId: number;
    let kidId: number;
    let helperId: number;
    let programId: number;
    let otherProgramId: number;
    let futureEventId: number;
    let startedEventId: number;
    let otherFutureEventId: number;

    async function wipe() {
        const people = await prisma.person.findMany({ where: { email: { contains: TAG } }, select: { id: true, householdId: true } });
        const ids = people.map((p) => p.id);
        const programs = await prisma.program.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const programIds = programs.map((p) => p.id);
        await prisma.rSVP.deleteMany({ where: { personId: { in: ids } } });
        await prisma.event.deleteMany({ where: { programId: { in: programIds } } });
        await prisma.programVolunteer.deleteMany({ where: { programId: { in: programIds } } });
        await prisma.programParticipant.deleteMany({ where: { programId: { in: programIds } } });
        await prisma.program.deleteMany({ where: { id: { in: programIds } } });
        await prisma.person.deleteMany({ where: { id: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: people.map((p) => p.householdId).filter((h): h is number => h !== null) } } });
    }

    const person = (label: string) =>
        prisma.person.create({ data: { email: `${label}-${TAG}@example.com`, name: label, household: { create: { name: `${label} ${TAG}` } } } });
    const program = (label: string) =>
        prisma.program.create({
            data: { appliesToYear: 2026, startAt: new Date('2026-01-01'), endAt: new Date('2027-12-31'), name: `${label} ${TAG}`, leadMentorId: leadId, maxParticipants: 10 },
        });
    const event = (pid: number, startOffset: number) =>
        prisma.event.create({ data: { name: TAG, programId: pid, startAt: new Date(Date.now() + startOffset), endAt: new Date(Date.now() + startOffset + 2 * HOUR) } });
    const rsvpYes = (eventId: number, personId: number) => prisma.rSVP.create({ data: { eventId, personId, status: 'ATTENDING' } });
    const rsvpStatus = async (eventId: number, personId: number) =>
        (await prisma.rSVP.findUnique({ where: { eventId_personId: { eventId, personId } } }))?.status ?? null;

    beforeEach(async () => {
        await wipe();
        leadId = (await person('lead')).id;
        kidId = (await person('kid')).id;
        helperId = (await person('helper')).id;
        programId = (await program('main')).id;
        otherProgramId = (await program('other')).id;
        futureEventId = (await event(programId, 24 * HOUR)).id;
        startedEventId = (await event(programId, -HOUR)).id;
        otherFutureEventId = (await event(otherProgramId, 24 * HOUR)).id;
        for (const pid of [programId, otherProgramId]) {
            await prisma.programParticipant.create({ data: { programId: pid, personId: kidId, status: 'ACTIVE' } });
        }
        await prisma.programParticipant.create({ data: { programId, personId: helperId, status: 'ACTIVE' } });
        await prisma.programVolunteer.create({ data: { programId, personId: helperId } });
        for (const [eventId, personId] of [[futureEventId, kidId], [startedEventId, kidId], [otherFutureEventId, kidId], [futureEventId, helperId]]) {
            await rsvpYes(eventId, personId);
        }
    });

    afterAll(wipe);

    async function withdraw(personId: number) {
        const p = await prisma.program.findUniqueOrThrow({ where: { id: programId } });
        expect(await withdrawParticipant(programId, personId, p)).not.toBeNull();
    }

    async function participantYes(eventId: number) {
        const counts = await todoCounts({ id: leadId, isSysadmin: false, isBoardMember: false } as AuthenticatedUser);
        const upcoming = counts.lead?.programs.find((p) => p.id === programId)?.upcoming.find((e) => e.eventId === eventId);
        return upcoming?.participants.yes;
    }

    it("drops a withdrawn participant's Yes from the lead's tally", async () => {
        expect(await participantYes(futureEventId)).toBe(1);

        await withdraw(kidId);

        expect(await participantYes(futureEventId)).toBe(0);
    });

    it('deletes RSVPs for events of this program that have not started, and nothing else', async () => {
        await withdraw(kidId);

        expect(await rsvpStatus(futureEventId, kidId)).toBeNull();
        expect(await rsvpStatus(startedEventId, kidId)).toBe('ATTENDING');
        expect(await rsvpStatus(otherFutureEventId, kidId)).toBe('ATTENDING');
        expect(await rsvpStatus(futureEventId, helperId)).toBe('ATTENDING');
    });

    it('keeps the RSVP of someone who also volunteers on the program', async () => {
        await withdraw(helperId);

        expect(await rsvpStatus(futureEventId, helperId)).toBe('ATTENDING');
    });

    it('deletes future RSVPs when an unpaid place is removed', async () => {
        await prisma.programParticipant.update({ where: { programId_personId: { programId, personId: kidId } }, data: { status: 'PENDING' } });
        const p = await prisma.program.findUniqueOrThrow({ where: { id: programId } });

        await deleteAndReleaseHold(programId, kidId, p);

        expect(await rsvpStatus(futureEventId, kidId)).toBeNull();
        expect(await rsvpStatus(startedEventId, kidId)).toBe('ATTENDING');
        expect(await rsvpStatus(otherFutureEventId, kidId)).toBe('ATTENDING');
    });

    it("leaves out a Yes kept by someone no longer enrolled, and still counts the lead's and volunteers'", async () => {
        await rsvpYes(futureEventId, leadId);
        await prisma.programParticipant.update({ where: { programId_personId: { programId, personId: kidId } }, data: { status: 'WITHDRAWN', endedAt: new Date() } });
        await prisma.programParticipant.update({ where: { programId_personId: { programId, personId: helperId } }, data: { status: 'WITHDRAWN', endedAt: new Date() } });

        const counts = await todoCounts({ id: leadId, isSysadmin: false, isBoardMember: false } as AuthenticatedUser);
        const upcoming = counts.lead?.programs.find((p) => p.id === programId)?.upcoming.find((e) => e.eventId === futureEventId);

        expect(upcoming?.participants.yes).toBe(1);
        expect(upcoming?.volunteers.yes).toBe(1);
    });
});
