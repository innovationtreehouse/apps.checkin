import { processPostEventEmails } from '../postEventEmails';
import prisma from '../prisma';

jest.mock('../email', () => ({
    sendEmail: jest.fn().mockResolvedValue(true)
}));

describe('Performance benchmark for processPostEventEmails', () => {
    let origFindMany: typeof prisma.event.findMany;
    let origFindUnique: typeof prisma.person.findUnique;
    let origParticipantFindMany: typeof prisma.person.findMany;
    let origEventUpdate: typeof prisma.event.update;
    let origEventUpdateMany: typeof prisma.event.updateMany;

    beforeAll(() => {
        origFindMany = prisma.event.findMany;
        origFindUnique = prisma.person.findUnique;
        origParticipantFindMany = prisma.person.findMany;
        origEventUpdate = prisma.event.update;
        origEventUpdateMany = prisma.event.updateMany;
    });

    afterAll(() => {
        prisma.event.findMany = origFindMany;
        prisma.person.findUnique = origFindUnique;
        prisma.person.findMany = origParticipantFindMany;
        prisma.event.update = origEventUpdate;
        prisma.event.updateMany = origEventUpdateMany;
    });

    it('benchmarks processPostEventEmails', async () => {
        const numEvents = 500;
        const mockEvents = Array.from({ length: numEvents }).map((_, i) => ({
            id: i + 1,
            name: `Event ${i + 1}`,
            program: {
                id: i + 1,
                leadMentorId: i + 1,
                volunteers: []
            },
            rsvps: [],
            visits: []
        }));

        let callCount = 0;
        prisma.event.findMany = jest.fn().mockImplementation(async () => {
            if (callCount === 0) {
                callCount++;
                return mockEvents as unknown as never;
            }
            return [];
        });

        prisma.event.update = jest.fn().mockImplementation(async () => { return {} as unknown as never; });
        prisma.event.updateMany = jest.fn().mockResolvedValue({ count: 1 });

        let uniqueCalls = 0;
        prisma.person.findUnique = jest.fn().mockImplementation(async ({ where }: { where: { id: number } }) => {
            uniqueCalls++;
            await new Promise(resolve => setTimeout(resolve, 5));
            return { email: `lead${where.id}@example.com` } as unknown as never;
        });

        let manyCalls = 0;
        prisma.person.findMany = jest.fn().mockImplementation(async ({ where }: { where: { id: { in: number[] } } }) => {
            manyCalls++;
            await new Promise(resolve => setTimeout(resolve, 10));
            const ids = where.id.in as number[];
            return ids.map(id => ({ id, email: `lead${id}@example.com` })) as unknown as never;
        });

        console.log(`Starting benchmark for ${numEvents} events...`);
        const start = Date.now();
        await processPostEventEmails({ forceImmediate: true, batchSize: numEvents });
        const end = Date.now();

        console.log(`Time taken: ${end - start}ms`);
        console.log(`findUnique calls: ${uniqueCalls}`);
        console.log(`findMany calls: ${manyCalls}`);

        expect(uniqueCalls).toBe(0);
        expect(manyCalls).toBe(1);
    });
});
