import { processPostEventEmails } from "../postEventEmails";
import prisma from "@/lib/prisma";
import { sendEmail } from "@/lib/email";

// Mock dependencies
jest.mock("@/lib/prisma", () => {
    const client = {
        event: {
            findMany: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
        },
        person: {
            findUnique: jest.fn(),
            findMany: jest.fn(),
        },
        integrationErrorLog: {
            create: jest.fn(),
        },
        $transaction: jest.fn(),
    };
    client.$transaction.mockImplementation((fn: (tx: typeof client) => Promise<unknown>) => fn(client));
    return { __esModule: true, default: client };
});

jest.mock("@/lib/email", () => ({
    sendEmail: jest.fn()
}));

jest.mock("@/lib/config", () => ({
    config: {
        baseUrl: jest.fn().mockReturnValue("http://localhost:3000")
    }
}));

describe("processPostEventEmails", () => {
    const mockNow = new Date("2024-05-01T12:00:00.000Z");

    beforeAll(() => {
        jest.useFakeTimers();
        jest.setSystemTime(mockNow);
    });

    afterAll(() => {
        jest.useRealTimers();
    });

    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.event.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.event.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    });

    it("uses 1-hour cutoff time when forceImmediate is false", async () => {
        (prisma.event.findMany as jest.Mock).mockResolvedValue([]);

        await processPostEventEmails({ forceImmediate: false });

        const expectedCutoff = new Date(mockNow.getTime() - 60 * 60 * 1000);
        expect(prisma.event.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    endAt: { lte: expectedCutoff },
                    postEventEmailSent: false,
                    attendanceConfirmedAt: null,
                    programId: { not: null }
                }),
                take: 50,
                orderBy: { id: 'asc' }
            })
        );
    });

    it("uses current time as cutoff when forceImmediate is true", async () => {
        (prisma.event.findMany as jest.Mock).mockResolvedValue([]);

        await processPostEventEmails({ forceImmediate: true });

        expect(prisma.event.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    endAt: { lte: mockNow }
                }),
                take: 50,
                orderBy: { id: 'asc' }
            })
        );
    });

    it("processes events in batches with cursor and take", async () => {
        const batch1 = Array.from({ length: 2 }, (_, i) => ({
            id: i + 1,
            name: `Event ${i + 1}`,
            program: { leadMentorId: 100, volunteers: [] },
            rsvps: [],
            visits: []
        }));
        const batch2 = Array.from({ length: 2 }, (_, i) => ({
            id: i + 3,
            name: `Event ${i + 3}`,
            program: { leadMentorId: 100, volunteers: [] },
            rsvps: [],
            visits: []
        }));

        (prisma.event.findMany as jest.Mock)
            .mockResolvedValueOnce(batch1)
            .mockResolvedValueOnce(batch2)
            .mockResolvedValueOnce([]); // end loop

        (prisma.person.findMany as jest.Mock).mockResolvedValue([{ id: 100, email: "lead@example.com" }]);
        (sendEmail as jest.Mock).mockResolvedValue(true);

        const result = await processPostEventEmails({ batchSize: 2 });

        expect(prisma.event.findMany).toHaveBeenCalledTimes(4); // three batches, then the stranded-claim sweep

        expect(prisma.event.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ take: 2 }));
        expect(prisma.event.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
            take: 2,
            where: expect.objectContaining({ id: { gt: 2 } })
        }));
        expect(prisma.event.findMany).toHaveBeenNthCalledWith(3, expect.objectContaining({
            take: 2,
            where: expect.objectContaining({ id: { gt: 4 } })
        }));

        expect(result.processedEvents).toBe(4);
        expect(result.emailsSent).toBe(4);
    });

    it("skips event if program is null", async () => {
        (prisma.event.findMany as jest.Mock).mockResolvedValueOnce([
            { id: 1, program: null }
        ]).mockResolvedValueOnce([]);

        const result = await processPostEventEmails();

        expect(result.processedEvents).toBe(1);
        expect(result.emailsSent).toBe(0);
        expect(sendEmail).not.toHaveBeenCalled();
    });

    it("uses leadMentorId to find recipientEmail and sends email successfully", async () => {
        (prisma.event.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: 10,
                name: "Test Event",
                program: { leadMentorId: 100, volunteers: [] },
                rsvps: [{ status: "ATTENDING" }],
                visits: [{}, {}]
            }
        ]).mockResolvedValueOnce([]);
        (prisma.person.findMany as jest.Mock).mockResolvedValue([{ id: 100, email: "lead@example.com" }]);
        (sendEmail as jest.Mock).mockResolvedValue(true);

        const result = await processPostEventEmails();

        expect(prisma.person.findMany).toHaveBeenCalledWith({
            where: { id: { in: [100] } },
            select: { id: true, email: true }
        });

        expect(sendEmail).toHaveBeenCalledWith(
            "lead@example.com",
            "Action Required: Confirm Attendance for Test Event",
            expect.any(String),
        );
        const html = (sendEmail as jest.Mock).mock.calls[0][2];
        expect(html).toContain("Event Completed: Test Event");
        expect(html).toContain("RSVPs (Attending): 1");
        expect(html).toContain("Logged Check-ins: 2");
        expect(html).toContain('<a href="http://localhost:3000/program-ops/sessions/10">Review &amp; Confirm Attendance</a>');

        expect(prisma.event.update).toHaveBeenCalledWith({
            where: { id: 10 },
            data: { postEventEmailSent: true, postEventEmailClaimedAt: null }
        });

        expect(result.processedEvents).toBe(1);
        expect(result.emailsSent).toBe(1);
    });

    it("falls back to core volunteer if leadMentorId is null", async () => {
        (prisma.event.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: 11,
                name: "Volunteer Event",
                program: {
                    leadMentorId: null,
                    volunteers: [
                        { person: { email: "core@example.com" } }
                    ]
                },
                rsvps: [],
                visits: []
            }
        ]).mockResolvedValueOnce([]);
        (sendEmail as jest.Mock).mockResolvedValue(true);

        (prisma.person.findMany as jest.Mock).mockResolvedValue([]);
        const result = await processPostEventEmails();

        expect(prisma.person.findMany).not.toHaveBeenCalled();
        expect(sendEmail).toHaveBeenCalledWith(
            "core@example.com",
            expect.any(String),
            expect.any(String)
        );
        expect(result.emailsSent).toBe(1);
    });

    it("skips sending if neither leadMentor nor core volunteer has an email", async () => {
        (prisma.event.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: 12,
                name: "No Email Event",
                program: {
                    leadMentorId: null,
                    volunteers: []
                },
                rsvps: [],
                visits: []
            }
        ]).mockResolvedValueOnce([]);

        const result = await processPostEventEmails();

        expect(sendEmail).not.toHaveBeenCalled();
        expect(result.emailsSent).toBe(0);
    });

    it("skips sending if leadMentor lacks email", async () => {
        (prisma.event.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: 14,
                name: "Lead Has No Email Event",
                program: { leadMentorId: 101, volunteers: [] },
                rsvps: [],
                visits: []
            }
        ]).mockResolvedValueOnce([]);
        (prisma.person.findMany as jest.Mock).mockResolvedValue([{ id: 101, email: null }]);

        const result = await processPostEventEmails();

        expect(prisma.person.findMany).toHaveBeenCalledWith({
            where: { id: { in: [101] } },
            select: { id: true, email: true }
        });
        expect(sendEmail).not.toHaveBeenCalled();
        expect(result.emailsSent).toBe(0);
    });

    it("does not update event postEventEmailSent if sendEmail returns false", async () => {
        (prisma.event.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: 13,
                name: "Failed Send Event",
                program: { leadMentorId: 100, volunteers: [] },
                rsvps: [],
                visits: []
            }
        ]).mockResolvedValueOnce([]);
        (prisma.person.findMany as jest.Mock).mockResolvedValue([{ id: 100, email: "lead@example.com" }]);
        (sendEmail as jest.Mock).mockResolvedValue(false); // sending fails

        const result = await processPostEventEmails();

        expect(sendEmail).toHaveBeenCalled();
        expect(prisma.event.update).not.toHaveBeenCalled();
        expect(prisma.event.updateMany).toHaveBeenLastCalledWith({
            where: { id: 13, postEventEmailClaimedAt: expect.any(Date), postEventEmailAttempts: { lt: 4 } },
            data: { postEventEmailClaimedAt: null, postEventEmailAttempts: { increment: 1 } },
        });
        expect(prisma.integrationErrorLog.create).not.toHaveBeenCalled();
        expect(result.emailsSent).toBe(0);
    });

    it("counts the last failed attempt and notes the Board when the release would pass the cap", async () => {
        (prisma.event.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: 16,
                name: "Last Attempt Event",
                program: { leadMentorId: 100, volunteers: [] },
                rsvps: [],
                visits: []
            }
        ]).mockResolvedValueOnce([]);
        (prisma.person.findMany as jest.Mock).mockResolvedValue([{ id: 100, email: "lead@example.com" }]);
        (sendEmail as jest.Mock).mockResolvedValue(false);
        (prisma.event.updateMany as jest.Mock)
            .mockResolvedValueOnce({ count: 1 }) // claim
            .mockResolvedValueOnce({ count: 0 }); // release refused at the cap

        await processPostEventEmails();

        expect(prisma.event.updateMany).toHaveBeenLastCalledWith({
            where: { id: 16, postEventEmailClaimedAt: expect.any(Date) },
            data: { postEventEmailAttempts: { increment: 1 }, postEventEmailClaimedAt: null },
        });
        expect(prisma.integrationErrorLog.create).toHaveBeenCalledWith({
            data: { source: "post-event-email", message: expect.stringContaining("event 16) failed 5 times"), context: { eventId: 16 } },
        });
    });

    it("notes the Board once for an event a crashed run left claimed at the cap", async () => {
        const claimedAt = new Date(mockNow.getTime() - 60 * 60 * 1000);
        (prisma.event.findMany as jest.Mock)
            .mockResolvedValueOnce([]) // no events to send
            .mockResolvedValueOnce([{ id: 17, name: "Stranded Event", postEventEmailClaimedAt: claimedAt }]);

        await processPostEventEmails();

        expect(prisma.event.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
            where: {
                postEventEmailSent: false,
                postEventEmailAttempts: { gte: 5 },
                attendanceConfirmedAt: null,
                postEventEmailClaimedAt: { lt: new Date(mockNow.getTime() - 15 * 60_000) },
            },
        }));
        expect(prisma.event.updateMany).toHaveBeenCalledWith({
            where: { id: 17, postEventEmailClaimedAt: claimedAt },
            data: { postEventEmailClaimedAt: null },
        });
        expect(prisma.integrationErrorLog.create).toHaveBeenCalledWith({
            data: {
                source: "post-event-email",
                message: expect.stringContaining("the last attempt did not finish, and the email may have sent"),
                context: { eventId: 17 },
            },
        });
    });

    it("clears the stranded claim and writes the note in one transaction", async () => {
        (prisma.event.findMany as jest.Mock)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ id: 19, name: "Stranded Event", postEventEmailClaimedAt: new Date(0) }]);
        const tx = {
            event: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
            integrationErrorLog: { create: jest.fn() },
        };
        (prisma.$transaction as jest.Mock).mockImplementationOnce((fn: (client: typeof tx) => Promise<unknown>) => fn(tx));

        await processPostEventEmails();

        expect(tx.event.updateMany).toHaveBeenCalledWith({
            where: { id: 19, postEventEmailClaimedAt: new Date(0) },
            data: { postEventEmailClaimedAt: null },
        });
        expect(tx.integrationErrorLog.create).toHaveBeenCalledTimes(1);
        expect(prisma.event.updateMany).not.toHaveBeenCalled();
        expect(prisma.integrationErrorLog.create).not.toHaveBeenCalled();
    });

    it("writes no note when another run cleared the stranded claim first", async () => {
        (prisma.event.findMany as jest.Mock)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ id: 18, name: "Stranded Event", postEventEmailClaimedAt: new Date(0) }]);
        (prisma.event.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

        await processPostEventEmails();

        expect(prisma.integrationErrorLog.create).not.toHaveBeenCalled();
    });

    it("does not send when another run holds the claim", async () => {
        (prisma.event.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: 15,
                name: "Claimed Event",
                program: { leadMentorId: 100, volunteers: [] },
                rsvps: [],
                visits: []
            }
        ]).mockResolvedValueOnce([]);
        (prisma.person.findMany as jest.Mock).mockResolvedValue([{ id: 100, email: "lead@example.com" }]);
        (prisma.event.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

        const result = await processPostEventEmails();

        expect(sendEmail).not.toHaveBeenCalled();
        expect(result.emailsSent).toBe(0);
    });
});
