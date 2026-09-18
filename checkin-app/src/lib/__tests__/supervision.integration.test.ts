/**
 * @jest-environment node
 */
/**
 * Integration coverage for the supervising-adult test (#1436 / #1550) against a
 * real Postgres — the half the unit tests mock away is the query itself: the
 * nested membership filter, and the participant-seat probe's "programme in
 * session now" OR (an event bracketing now, or the programme's own dates).
 *
 * Also drives the two surfaces that consume it end to end: the departure
 * interrupt ladder (processCheckout) and the compliance banner
 * (getFullAttendance).
 */
import prisma from '@/lib/prisma';
import { getFullAttendance } from '@/lib/getFullAttendance';
import { processCheckin, processCheckout } from '@/lib/scan-service';
import { supervisingAdultCount, supervisingAdultVisits } from '@/lib/supervision';
import type { Person } from '@/generated/prisma/client';

jest.mock('@/lib/notifications', () => ({
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
}));

const TAG = 'supervision-test';
const HOUR = 60 * 60 * 1000;
const CLEARED = new Date('2026-06-01');

describe('supervising adults (integration)', () => {
    const people: Record<string, Person> = {};
    const householdIds: number[] = [];
    const programIds: number[] = [];

    /** A cleared adult of their own ACTIVE member household. */
    async function makeAdult(key: string, opts: { isKeyholder?: boolean; cleared?: boolean } = {}) {
        const person = await prisma.person.create({
            data: {
                name: key,
                email: `${key}-${TAG}@example.com`,
                isDeclaredAdult: true,
                isKeyholder: opts.isKeyholder ?? false,
                lastBackgroundCheck: opts.cleared === false ? null : CLEARED,
                household: { create: { name: `${key} HH ${TAG}` } },
            },
        });
        await prisma.orgMembership.create({ data: { householdId: person.householdId, status: 'ACTIVE' } });
        householdIds.push(person.householdId);
        people[key] = person;
        return person;
    }

    /** A second adult inside an existing person's household. */
    async function makeHouseholdMate(key: string, ofKey: string) {
        people[key] = await prisma.person.create({
            data: {
                name: key,
                email: `${key}-${TAG}@example.com`,
                isDeclaredAdult: true,
                lastBackgroundCheck: CLEARED,
                householdId: people[ofKey].householdId,
            },
        });
        return people[key];
    }

    async function enrol(key: string, programId: number) {
        await prisma.programParticipant.create({
            data: { programId, personId: people[key].id, status: 'ACTIVE', pendingSince: null },
        });
    }

    const checkIn = (key: string) =>
        prisma.visit.create({ data: { personId: people[key].id, arrivedAt: new Date() } });

    beforeAll(async () => {
        await makeAdult('ann', { isKeyholder: true });
        await makeHouseholdMate('al', 'ann');
        await makeAdult('ben');
        await makeAdult('cal');
        await makeAdult('dee');
        await makeAdult('gil');
        await makeAdult('eve', { cleared: false });

        people.fay = await prisma.person.create({
            data: {
                name: 'fay',
                email: `fay-${TAG}@example.com`,
                dateOfBirth: new Date('2015-01-01'),
                household: { create: { name: `fay HH ${TAG}` } },
            },
        });
        householdIds.push(people.fay.householdId);

        // In session by EVENT: no programme dates at all, one event bracketing now.
        const byEvent = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Event Prog ${TAG}` } });
        programIds.push(byEvent.id);
        await prisma.event.create({
            data: {
                name: `Now ${TAG}`,
                programId: byEvent.id,
                startAt: new Date(Date.now() - HOUR),
                endAt: new Date(Date.now() + HOUR),
            },
        });
        await enrol('dee', byEvent.id);

        // In session by DATES: no events, the programme's own dates cover today.
        const byDates = await prisma.program.create({
            data: {
                name: `Dates Prog ${TAG}`,
                phase: 'RUNNING',
                startAt: new Date(Date.now() - 30 * 24 * HOUR),
                endAt: new Date(Date.now() + 30 * 24 * HOUR),
            },
        });
        programIds.push(byDates.id);
        await enrol('gil', byDates.id);
    });

    /** Only this suite's rows: a bare deleteMany({}) wipes every other suite's visits too. */
    const ownIds = () => Object.values(people).map(p => p.id);

    beforeEach(async () => {
        await prisma.visit.deleteMany({ where: { personId: { in: ownIds() } } });
    });

    afterAll(async () => {
        const ids = ownIds();
        await prisma.visit.deleteMany({ where: { personId: { in: ids } } });
        await prisma.programParticipant.deleteMany({ where: { programId: { in: programIds } } });
        await prisma.event.deleteMany({ where: { programId: { in: programIds } } });
        await prisma.program.deleteMany({ where: { id: { in: programIds } } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: householdIds } } });
        await prisma.person.deleteMany({ where: { id: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
    });

    const count = async () => supervisingAdultCount(await supervisingAdultVisits());

    describe('the test itself', () => {
        it('counts cleared adults of ACTIVE member households, one per household', async () => {
            await checkIn('ann');
            await checkIn('al');
            await checkIn('ben');

            expect(await count()).toBe(2);
        });

        it('never counts an adult holding a seat on a programme in session now', async () => {
            await checkIn('ann');
            await checkIn('dee');
            await checkIn('gil');

            expect(await count()).toBe(1);
        });

        it('never counts an adult with no background check on file', async () => {
            await checkIn('ann');
            await checkIn('eve');

            expect(await count()).toBe(1);
        });

        it('never counts a youth', async () => {
            await checkIn('ann');
            await checkIn('fay');

            expect(await count()).toBe(1);
        });
    });

    describe('the compliance banner (#1550)', () => {
        it('is clear when two supervising adults cover an unaccompanied youth', async () => {
            await checkIn('ann');
            await checkIn('ben');
            await checkIn('fay');

            expect((await getFullAttendance()).safety.isTwoDeepViolation).toBe(false);
        });

        it('fires when the second adult is a programme participant, not a supervisor', async () => {
            await checkIn('ann');
            await checkIn('dee');
            await checkIn('fay');

            expect((await getFullAttendance()).safety.isTwoDeepViolation).toBe(true);
        });

        it('fires when the two adults share a household', async () => {
            await checkIn('ann');
            await checkIn('al');
            await checkIn('fay');

            expect((await getFullAttendance()).safety.isTwoDeepViolation).toBe(true);
        });
    });

    describe('the departure interrupt ladder (#1436)', () => {
        it('warns without a confirm when the third supervising adult leaves', async () => {
            await checkIn('ann');
            await checkIn('ben');
            const cal = await checkIn('cal');

            const res = await processCheckout(people.cal, cal.id, 'kiosk');
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.warning).toMatch(/only 2 supervising adults remain/i);
            expect(await prisma.visit.findUnique({ where: { id: cal.id } })).toMatchObject({ supervisionWarnedAt: null });
        });

        it('warns AND requires a second badge when the next one leaves a youth here', async () => {
            await checkIn('ann');
            await checkIn('fay');
            const ben = await checkIn('ben');

            const first = await processCheckout(people.ben, ben.id, 'kiosk');
            expect(first.status).toBe(400);
            expect((await first.json()).type).toBe('warning');
            const stamped = await prisma.visit.findUnique({ where: { id: ben.id } });
            expect(stamped?.supervisionWarnedAt).not.toBeNull();
            expect(stamped?.departedAt).toBeNull();

            const second = await processCheckout(people.ben, ben.id, 'kiosk');
            expect(second.status).toBe(200);
            expect((await prisma.visit.findUnique({ where: { id: ben.id } }))?.departedAt).not.toBeNull();
        });

        it('warns without a confirm when the same departure leaves no youth behind', async () => {
            await checkIn('ann');
            const ben = await checkIn('ben');

            const res = await processCheckout(people.ben, ben.id, 'kiosk');

            expect(res.status).toBe(200);
            expect((await res.json()).warning).toMatch(/leaves only 1 supervising adult/i);
            const closed = await prisma.visit.findUnique({ where: { id: ben.id } });
            expect(closed?.supervisionWarnedAt).toBeNull();
            expect(closed?.departedAt).not.toBeNull();
        });

        it('stays quiet when the departing adult\'s household is still represented', async () => {
            await checkIn('ann');
            const al = await checkIn('al');
            await checkIn('ben');

            const res = await processCheckout(people.al, al.id, 'kiosk');

            expect(res.status).toBe(200);
            expect((await res.json()).warning).toBeUndefined();
        });

        it('warns a youth checking in below two, and lets them in anyway', async () => {
            await checkIn('ann');

            const res = await processCheckin(people.fay, 'kiosk');
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.type).toBe('checkin');
            expect(body.warning).toMatch(/fewer than 2 supervising adults/i);
        });
    });
});
