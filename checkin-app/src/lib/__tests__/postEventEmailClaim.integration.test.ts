import { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { processPostEventEmails, POST_EVENT_EMAIL_MAX_ATTEMPTS } from "@/lib/postEventEmails";

jest.mock("@/lib/email", () => ({
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
    sendEmail: jest.fn(),
}));

const TAG = `l8claim${Date.now()}`;
const leadEmail = `${TAG}@example.com`;

const sendsToLead = () => (sendEmail as jest.Mock).mock.calls.filter(([to]) => to === leadEmail).length;

async function createEndedEvent(data: { postEventEmailClaimedAt?: Date; postEventEmailAttempts?: number } = {}) {
    const lead = await prisma.person.create({
        data: { email: leadEmail, name: `${TAG} Lead`, household: { create: { name: `${TAG} HH` } } },
    });
    const program = await prisma.program.create({
        data: { appliesToYear: 2026, startAt: new Date("2026-01-01"), endAt: new Date("2026-12-31"), name: `${TAG} Program`, leadMentorId: lead.id },
    });
    const now = Date.now();
    return prisma.event.create({
        data: {
            name: `${TAG} Event`,
            startAt: new Date(now - 3 * 60 * 60 * 1000),
            endAt: new Date(now - 2 * 60 * 60 * 1000),
            programId: program.id,
            ...data,
        },
    });
}

async function cleanup() {
    await prisma.event.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.program.deleteMany({ where: { name: { startsWith: TAG } } });
    const people = await prisma.person.findMany({ where: { email: leadEmail }, select: { householdId: true } });
    await prisma.person.deleteMany({ where: { email: leadEmail } });
    await prisma.household.deleteMany({ where: { id: { in: people.map((p) => p.householdId).filter((id): id is number => id !== null) } } });
    await prisma.integrationErrorLog.deleteMany({ where: { source: "post-event-email", message: { contains: TAG } } });
}

describe("processPostEventEmails claims each event before sending", () => {
    beforeEach(async () => {
        await cleanup();
        jest.clearAllMocks();
    });

    afterAll(cleanup);

    it("sends once when two runs overlap", async () => {
        const event = await createEndedEvent();
        (sendEmail as jest.Mock).mockImplementation(async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return true;
        });

        await Promise.all([
            processPostEventEmails({ forceImmediate: true }),
            processPostEventEmails({ forceImmediate: true }),
        ]);

        expect(sendsToLead()).toBe(1);
        const row = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
        expect(row.postEventEmailSent).toBe(true);
    });

    it("leaves a fresh claim alone and retries a stale one", async () => {
        (sendEmail as jest.Mock).mockResolvedValue(true);
        const event = await createEndedEvent({ postEventEmailClaimedAt: new Date(Date.now() - 60_000), postEventEmailAttempts: 1 });

        await processPostEventEmails({ forceImmediate: true });
        expect(sendsToLead()).toBe(0);

        await prisma.event.update({ where: { id: event.id }, data: { postEventEmailClaimedAt: new Date(Date.now() - 60 * 60 * 1000) } });
        await processPostEventEmails({ forceImmediate: true });

        expect(sendsToLead()).toBe(1);
        const row = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
        expect(row.postEventEmailSent).toBe(true);
        expect(row.postEventEmailClaimedAt).toBeNull();
        // The taken-over claim was a run that died mid-send, so it counts.
        expect(row.postEventEmailAttempts).toBe(2);
    });

    it("stops taking over stale claims at the cap", async () => {
        (sendEmail as jest.Mock).mockResolvedValue(true);
        await createEndedEvent({
            postEventEmailClaimedAt: new Date(Date.now() - 60 * 60 * 1000),
            postEventEmailAttempts: POST_EVENT_EMAIL_MAX_ATTEMPTS,
        });

        await processPostEventEmails({ forceImmediate: true });

        expect(sendsToLead()).toBe(0);
    });

    it("stops after the attempt cap and leaves the Board a note", async () => {
        (sendEmail as jest.Mock).mockResolvedValue(false);
        const event = await createEndedEvent();

        for (let run = 0; run < POST_EVENT_EMAIL_MAX_ATTEMPTS + 2; run++) {
            await processPostEventEmails({ forceImmediate: true });
        }

        expect(sendsToLead()).toBe(POST_EVENT_EMAIL_MAX_ATTEMPTS);
        const row = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
        expect(row.postEventEmailSent).toBe(false);
        expect(row.postEventEmailAttempts).toBe(POST_EVENT_EMAIL_MAX_ATTEMPTS);
        const notes = await prisma.integrationErrorLog.findMany({ where: { source: "post-event-email", message: { contains: TAG } } });
        expect(notes).toHaveLength(1);
    });

    it("counts a taken-over claim whose send then fails once", async () => {
        (sendEmail as jest.Mock).mockResolvedValue(false);
        const event = await createEndedEvent({ postEventEmailClaimedAt: new Date(Date.now() - 60 * 60 * 1000), postEventEmailAttempts: 1 });

        await processPostEventEmails({ forceImmediate: true });

        expect(sendsToLead()).toBe(1);
        const row = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
        expect(row.postEventEmailClaimedAt).toBeNull();
        expect(row.postEventEmailAttempts).toBe(2);
    });

    it("keeps processing the run's other events when one is deleted mid-run", async () => {
        (sendEmail as jest.Mock).mockResolvedValue(false);
        const deleted = await createEndedEvent();
        const other = await prisma.event.create({
            data: { name: `${TAG} Other Event`, startAt: deleted.startAt, endAt: deleted.endAt, programId: deleted.programId },
        });
        // Delete the event right after its claim is released, before the run re-reads it.
        const realUpdateMany = prisma.event.updateMany.bind(prisma.event);
        const spy = jest.spyOn(prisma.event, "updateMany").mockImplementation(((args: Prisma.EventUpdateManyArgs) =>
            realUpdateMany(args).then(async (result) => {
                if (args.where?.id === deleted.id && args.where.postEventEmailClaimedAt instanceof Date) {
                    await prisma.event.delete({ where: { id: deleted.id } });
                }
                return result;
            })) as never);

        try {
            await processPostEventEmails({ forceImmediate: true });
        } finally {
            spy.mockRestore();
        }

        expect(await prisma.event.findUnique({ where: { id: deleted.id } })).toBeNull();
        const row = await prisma.event.findUniqueOrThrow({ where: { id: other.id } });
        expect(row.postEventEmailAttempts).toBe(1);
    });
});
