/**
 * @jest-environment node
 */
import prisma from '@/lib/prisma';
import { findAssociatedEventAt, processVisitCheckout } from '@/lib/attendanceTransitions';

describe('Auto-Association and Checkout Chunking Logic', () => {
    let programAId: number;
    let programBId: number;
    let programCId: number;
    let programDId: number;
    
    let eventAId: number; // 10am - 12pm
    let eventBId: number; // 12pm - 2pm
    let eventCId: number; // 12pm - 2pm (Different program)
    let eventDId: number; // 2pm - 4pm
    
    let participantId: number;
    let householdId: number;
    const baseDateString = '2026-03-09T';

    beforeAll(async () => {
        // Clean up
        await prisma.visit.deleteMany();
        await prisma.programParticipant.deleteMany();
        await prisma.event.deleteMany();
        await prisma.programInstance.deleteMany();
        await prisma.program.deleteMany();
        await prisma.person.deleteMany({
            where: { email: 'auto-assoc-test@example.com' }
        });

        // Setup User
        const user = await prisma.person.create({
            data: { email: 'auto-assoc-test@example.com', name: 'Auto Assoc Tester', household: { create: { name: "Test HH" } } }
        });
        participantId = user.id;
        householdId = user.householdId;

        // Setup Programs
        const progA = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Program A' } });
        programAId = progA.id;
        const progB = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Program B' } });
        programBId = progB.id;
        const progC = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Program C' } });
        programCId = progC.id;
        const progD = await prisma.program.create({
            data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Program D', leadMentorId: participantId }
        });
        programDId = progD.id;

        // Setup Events
        // Event A: 10:00 to 12:00
        const evtA = await prisma.event.create({
            data: {
                programId: programAId,
                name: 'Event A',
                startAt: new Date(`${baseDateString}10:00:00Z`),
                endAt: new Date(`${baseDateString}12:00:00Z`)
            }
        });
        eventAId = evtA.id;

        // Event B: 12:00 to 14:00 (Back to back)
        const evtB = await prisma.event.create({
            data: {
                programId: programBId,
                name: 'Event B',
                startAt: new Date(`${baseDateString}12:00:00Z`),
                endAt: new Date(`${baseDateString}14:00:00Z`)
            }
        });
        eventBId = evtB.id;

        // Event C: 12:00 to 14:00 (Concurrent with B, but user NOT enrolled)
        const evtC = await prisma.event.create({
            data: {
                programId: programCId,
                name: 'Event C',
                startAt: new Date(`${baseDateString}12:00:00Z`),
                endAt: new Date(`${baseDateString}14:00:00Z`)
            }
        });
        eventCId = evtC.id;

        // Event D: 14:00 to 16:00
        const evtD = await prisma.event.create({
            data: {
                programId: programDId,
                name: 'Event D',
                startAt: new Date(`${baseDateString}14:00:00Z`),
                endAt: new Date(`${baseDateString}16:00:00Z`)
            }
        });
        eventDId = evtD.id;

        // Enroll User in A and B
        await prisma.programParticipant.create({
            data: { programId: programAId, personId: participantId }
        });
        await prisma.programParticipant.create({
            data: { programId: programBId, personId: participantId }
        });
    });

    afterAll(async () => {
        // Clean up
        await prisma.visit.deleteMany();
        await prisma.programParticipant.deleteMany();
        await prisma.event.deleteMany();
        await prisma.programInstance.deleteMany();
        await prisma.program.deleteMany();
        await prisma.person.deleteMany({
            where: { id: participantId }
        });
        await prisma.household.deleteMany({
            where: { id: householdId }
        });
    });

    describe('findAssociatedEventAt()', () => {
        it('should return null if check-in is more than 4 hours before event', async () => {
            const checkinTime = new Date(`${baseDateString}05:30:00Z`); // 4.5 hours before 10am
            const eventId = await findAssociatedEventAt(participantId, checkinTime);
            expect(eventId).toBeNull();
        });

        it('should return Event A if check-in is exactly 4 hours before event', async () => {
            const checkinTime = new Date(`${baseDateString}06:00:00Z`); // exactly 4 hours before 10am
            const eventId = await findAssociatedEventAt(participantId, checkinTime);
            expect(eventId).toBe(eventAId);
        });

        it('should return Event A if check-in is during Event A', async () => {
            const checkinTime = new Date(`${baseDateString}11:00:00Z`); // During 10am-12pm
            const eventId = await findAssociatedEventAt(participantId, checkinTime);
            expect(eventId).toBe(eventAId);
        });

        it('should NOT return Event C even if during time, because user is not enrolled', async () => {
            const checkinTime = new Date(`${baseDateString}12:30:00Z`); 
            const eventId = await findAssociatedEventAt(participantId, checkinTime);
            // Even though Event C is 12-2, user is enrolled in B, so it should return B, not C.
            expect(eventId).toBe(eventBId);
            expect(eventId).not.toBe(eventCId);
        });

        it('should return Event D if user is the lead mentor of Program D', async () => {
            const checkinTime = new Date(`${baseDateString}14:30:00Z`); // During 2pm-4pm
            const eventId = await findAssociatedEventAt(participantId, checkinTime);
            expect(eventId).toBe(eventDId);
        });
    });

    describe('processVisitCheckout()', () => {
        it('should not split a visit that falls completely within one event', async () => {
            const visit = await prisma.visit.create({
                data: {
                    personId: participantId,
                    arrivedAt: new Date(`${baseDateString}10:15:00Z`),
                    associatedEventId: eventAId
                }
            });

            const checkoutTime = new Date(`${baseDateString}11:45:00Z`); // Stays entirely within Event A
            const finalVisits = await processVisitCheckout(visit.id, checkoutTime, prisma, "TYPED");

            expect(finalVisits.length).toBe(1);
            expect(finalVisits[0].associatedEventId).toBe(eventAId);
            expect(finalVisits[0].departedAt).toEqual(checkoutTime);
        });

        it('should split a visit spanning back-to-back enrolled events', async () => {
            // User arrives 9:30 (before A), stays through A (10-12), and leaves during B (at 1:00pm)
            const arrivalTime = new Date(`${baseDateString}09:30:00Z`);
            const visit = await prisma.visit.create({
                data: {
                    personId: participantId,
                    arrivedAt: arrivalTime,
                    associatedEventId: null // We'll say it wasn't associated on entry for testing the chunker
                }
            });

            const checkoutTime = new Date(`${baseDateString}13:00:00Z`); // Leaves during Event B
            const finalVisits = await processVisitCheckout(visit.id, checkoutTime, prisma, "TYPED");

            // Expecting 3 visits:
            // 1. Unassociated gap (09:30 -> 10:00)
            // 2. Event A (10:00 -> 12:00)
            // 3. Event B (12:00 -> 13:00)
            
            expect(finalVisits.length).toBe(3);
            
            expect(finalVisits[0].arrivedAt).toEqual(arrivalTime);
            expect(finalVisits[0].departedAt).toEqual(new Date(`${baseDateString}10:00:00Z`));
            expect(finalVisits[0].associatedEventId).toBeNull();

            expect(finalVisits[1].arrivedAt).toEqual(new Date(`${baseDateString}10:00:00Z`));
            expect(finalVisits[1].departedAt).toEqual(new Date(`${baseDateString}12:00:00Z`));
            expect(finalVisits[1].associatedEventId).toBe(eventAId);

            expect(finalVisits[2].arrivedAt).toEqual(new Date(`${baseDateString}12:00:00Z`));
            expect(finalVisits[2].departedAt).toEqual(checkoutTime);
            expect(finalVisits[2].associatedEventId).toBe(eventBId);
        });

        it('should continue to chunk into the first event if the user is not enrolled in subsequent events', async () => {
            // Un-enroll user from B so they are ONLY enrolled in A.
            await prisma.programParticipant.deleteMany({
                where: { personId: participantId, programId: programBId }
            });

            // Arrives during A, leaves during B time
            const arrivalTime = new Date(`${baseDateString}10:30:00Z`);
            const visit = await prisma.visit.create({
                data: {
                    personId: participantId,
                    arrivedAt: arrivalTime,
                    associatedEventId: eventAId
                }
            });

            const checkoutTime = new Date(`${baseDateString}13:00:00Z`); // Leaves during Event B/C time
            const finalVisits = await processVisitCheckout(visit.id, checkoutTime, prisma, "TYPED");

            // Since user is not enrolled in B or C anymore, it should simply extend their stay in A
            // until checkout time.
            
            expect(finalVisits.length).toBe(1);

            expect(finalVisits[0].associatedEventId).toBe(eventAId);
            expect(finalVisits[0].arrivedAt).toEqual(arrivalTime);
            expect(finalVisits[0].departedAt).toEqual(checkoutTime);
        });

        it('should chunk into Event D if user is lead mentor', async () => {
            // Arrives at 13:30, leaves at 15:00
            const arrivalTime = new Date(`${baseDateString}13:30:00Z`);
            const visit = await prisma.visit.create({
                data: {
                    personId: participantId,
                    arrivedAt: arrivalTime
                }
            });

            const checkoutTime = new Date(`${baseDateString}15:00:00Z`);
            const finalVisits = await processVisitCheckout(visit.id, checkoutTime, prisma, "TYPED");

            expect(finalVisits.length).toBe(2);

            // 1. Unassociated gap (13:30 -> 14:00)
            expect(finalVisits[0].associatedEventId).toBeNull();
            expect(finalVisits[0].departedAt).toEqual(new Date(`${baseDateString}14:00:00Z`));

            // 2. Event D (14:00 -> 15:00)
            expect(finalVisits[1].associatedEventId).toBe(eventDId);
            expect(finalVisits[1].departedAt).toEqual(checkoutTime);
        });
    });
});
