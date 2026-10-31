import { processPostEventEmails } from "../postEventEmails";
import prisma from "@/lib/prisma";
import { sendEmail } from "@/lib/email";

// Mock dependencies
jest.mock("@/lib/prisma", () => {
    return {
        __esModule: true,
        default: {
            event: {
                findMany: jest.fn(),
                update: jest.fn(),
            },
            person: {
                findUnique: jest.fn(),
                findMany: jest.fn(),
            }
        }
    };
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

        expect(prisma.event.findMany).toHaveBeenCalledTimes(3);

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
            data: { postEventEmailSent: true }
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
        expect(result.emailsSent).toBe(0);
    });
});
