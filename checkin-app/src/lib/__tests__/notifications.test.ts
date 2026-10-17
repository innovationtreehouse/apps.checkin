import { sendNotification, notifyNewProgramAnnounced } from '../notifications';
import { sendEmail } from '../email';
import { isActiveOrgMemberThrough } from '../orgMembership';
import prisma from '../prisma';

jest.mock('../email', () => ({
    sendEmail: jest.fn(),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));
jest.mock('../orgMembership', () => ({
    ACTIVE_ORG_MEMBER_PERSON_WHERE: {},
    programCoverageDate: () => new Date('2026-12-01'),
    isActiveOrgMemberThrough: jest.fn(),
}));
jest.mock('../prisma', () => ({
    __esModule: true,
    default: { person: { findUnique: jest.fn(), findMany: jest.fn() } },
}));

const mockSendEmail = sendEmail as jest.Mock;
const mockIsActiveOrgMemberThrough = isActiveOrgMemberThrough as jest.Mock;
const mockFindUnique = (prisma as unknown as { person: { findUnique: jest.Mock } }).person.findUnique;
const mockFindMany = (prisma as unknown as { person: { findMany: jest.Mock } }).person.findMany;

describe('sendNotification return contract', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns true and sends nothing when email is disabled (no forever-retry)', async () => {
        mockFindUnique.mockResolvedValue({ email: 'a@b.com', name: 'A', notificationSettings: { email: false } });
        await expect(sendNotification(1, 'CHECKIN', {})).resolves.toBe(true);
        expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('returns sendEmail boolean when enabled', async () => {
        mockFindUnique.mockResolvedValue({ email: 'a@b.com', name: 'A', notificationSettings: {} });
        mockSendEmail.mockResolvedValue(true);
        await expect(sendNotification(1, 'CHECKIN', {})).resolves.toBe(true);

        mockSendEmail.mockResolvedValue(false);
        await expect(sendNotification(1, 'CHECKIN', {})).resolves.toBe(false);
    });

    it('returns false when sendEmail throws (retryable)', async () => {
        mockFindUnique.mockResolvedValue({ email: 'a@b.com', name: 'A', notificationSettings: {} });
        mockSendEmail.mockRejectedValue(new Error('boom'));
        jest.spyOn(console, 'error').mockImplementation(() => {});
        await expect(sendNotification(1, 'CHECKIN', {})).resolves.toBe(false);
    });

    it('returns true when user not found (nothing to ever send)', async () => {
        mockFindUnique.mockResolvedValue(null);
        await expect(sendNotification(1, 'CHECKIN', {})).resolves.toBe(true);
        expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('PROGRAM_ASSIGNMENT sends the welcome email with a manage link, not the generic "System Action" copy (#1220)', async () => {
        mockFindUnique.mockResolvedValue({ email: 'lead@b.com', name: 'Lead', notificationSettings: {} });
        mockSendEmail.mockResolvedValue(true);

        await sendNotification(7, 'PROGRAM_ASSIGNMENT', { programName: 'FLL Team A', programId: 42 });

        expect(mockSendEmail).toHaveBeenCalledTimes(1);
        const [to, subject, html] = mockSendEmail.mock.calls[0];
        expect(to).toBe('lead@b.com');
        expect(subject).toBe('Your Innovation Treehouse Program has been Created!');
        expect(html).not.toContain('System Action');
        expect(html).toContain('FLL Team A');
        expect(html).toContain('/program-ops/programs/42');
        expect(html).toContain('href=');
    });
});

describe('notifyNewProgramAnnounced opt-in filtering', () => {
    // clearAllMocks() wipes call data but NOT implementations, so the
    // mockRejectedValue('boom') set in the sendNotification describe above would
    // leak in and make these sends reject — recording the calls these tests
    // assert on while incidentally logging "Failed to send new-program
    // notifications:". Reset sendEmail to succeed: these tests exercise the
    // recipient-filtering logic, not the send failure path.
    beforeEach(() => {
        jest.clearAllMocks();
        mockSendEmail.mockResolvedValue(true);
    });

    const program = { name: 'Robotics', startAt: null, endAt: new Date('2026-12-01') };

    it('emails only prefs-passing users, defaulting ON, when coverage passes for all', async () => {
        mockFindMany.mockResolvedValue([
            { id: 1, email: 'in@b.com', name: 'In', notificationSettings: { notifyNewPrograms: true } },
            { id: 2, email: 'def@b.com', name: 'Def', notificationSettings: {} },            // default ON
            { id: 3, email: 'null@b.com', name: 'Null', notificationSettings: null },        // default ON
            { id: 4, email: 'out@b.com', name: 'Out', notificationSettings: { notifyNewPrograms: false } },
            { id: 5, email: 'noemail@b.com', name: 'NoE', notificationSettings: { email: false } },
            { id: 6, email: '', name: 'Empty', notificationSettings: {} },                   // empty address
        ]);
        mockIsActiveOrgMemberThrough.mockResolvedValue(true);

        await notifyNewProgramAnnounced(program);

        expect(mockSendEmail).toHaveBeenCalledTimes(3);
        const recipients = mockSendEmail.mock.calls.map(c => c[0]);
        expect(recipients).toEqual(['in@b.com', 'def@b.com', 'null@b.com']);
    });

    it('excludes a prefs-passing person whose coverage does not extend through the program (the #1061 gate)', async () => {
        mockFindMany.mockResolvedValue([
            { id: 1, email: 'covered@b.com', name: 'Covered', notificationSettings: {} },
            { id: 2, email: 'uncovered@b.com', name: 'Uncovered', notificationSettings: {} },
        ]);
        mockIsActiveOrgMemberThrough.mockImplementation((id: number) => Promise.resolve(id !== 2));

        await notifyNewProgramAnnounced(program);

        expect(mockSendEmail).toHaveBeenCalledTimes(1);
        const recipients = mockSendEmail.mock.calls.map(c => c[0]);
        expect(recipients).toEqual(['covered@b.com']);
        expect(mockIsActiveOrgMemberThrough).toHaveBeenCalledWith(2, new Date('2026-12-01'));
    });
});
