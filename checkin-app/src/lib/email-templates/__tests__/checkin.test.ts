import { sendCheckinNotifications } from '@/lib/notifications';
import { sendEmail } from '@/lib/email';
import prisma from '@/lib/prisma';

jest.mock('@/lib/email', () => ({ sendEmail: jest.fn().mockResolvedValue(true), runPaced: jest.fn() }));
jest.mock('@/lib/appSettings', () => ({ resolveDisplayTimezone: jest.fn().mockResolvedValue('UTC') }));
jest.mock('@/lib/orgMembership', () => ({ ACTIVE_ORG_MEMBER_PERSON_WHERE: {} }));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        person: { findUnique: jest.fn(), findMany: jest.fn() },
        emailTemplate: { findUnique: jest.fn().mockResolvedValue(null) },
    },
}));

const AT = new Date('2023-10-27T14:30:00Z');
const findUnique = prisma.person.findUnique as jest.Mock;
const findMany = prisma.person.findMany as jest.Mock;
const send = sendEmail as jest.Mock;

const mockParticipant = (name: string) => findUnique.mockResolvedValue({
    id: 1, name, email: 'john@example.org', householdId: 5, notificationSettings: { emailCheckinReceipts: true },
});
const mockLead = (name: string) => findMany.mockResolvedValue([
    { id: 2, name, email: 'jane@example.org', notificationSettings: { emailDependentCheckins: true } },
]);
const htmlTo = (to: string): string => send.mock.calls.find((c) => c[0] === to)?.[2];

beforeEach(() => {
    send.mockClear();
    mockParticipant('John Doe');
    mockLead('Jane Lead');
});

describe('checkin.receipt', () => {
    it('sends a check-in receipt with the right words and emoji', async () => {
        await sendCheckinNotifications(1, 'checkin', null, AT);

        const html = htmlTo('john@example.org');
        expect(send.mock.calls.find((c) => c[0] === 'john@example.org')?.[1]).toBe('✅ John Doe checked in to Innovation Treehouse');
        expect(html).toContain('✅ Visit Started');
        expect(html).toContain('John Doe checked in to Innovation Treehouse.');
        expect(html).toContain('📅 Friday, October 27');
        expect(html).toContain('🕐 2:30');
    });

    it('sends a check-out receipt with the right words and emoji', async () => {
        await sendCheckinNotifications(1, 'checkout', null, AT);

        const html = htmlTo('john@example.org');
        expect(html).toContain('👋 Visit Ended');
        expect(html).toContain('John Doe checked out of Innovation Treehouse.');
        expect(html).toContain('📅 Friday, October 27');
    });

    it('indicates the check-in source when provided', async () => {
        await sendCheckinNotifications(1, 'checkin', 'SCANNER', AT);
        expect(htmlTo('john@example.org')).toContain('via badge scan');

        send.mockClear();
        await sendCheckinNotifications(1, 'checkin', 'WEB', AT);
        expect(htmlTo('john@example.org')).toContain('via the web app');

        send.mockClear();
        await sendCheckinNotifications(1, 'checkin', null, AT);
        expect(htmlTo('john@example.org')).not.toContain('📍 via');
    });

    it('escapes HTML in the participant name to prevent content injection', async () => {
        mockParticipant('<img src=x onerror=alert(1)><script>evil()</script>');

        await sendCheckinNotifications(1, 'checkin', null, AT);

        const html = htmlTo('john@example.org');
        expect(html).not.toContain('<img src=x');
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;evil()&lt;/script&gt;');
    });
});

describe('checkin.householdMember', () => {
    it('sends the household lead a check-in notice', async () => {
        await sendCheckinNotifications(1, 'checkin', null, AT);

        const html = htmlTo('jane@example.org');
        expect(html).toContain('✅ Household Member Arrival');
        expect(html).toContain('Hi Jane Lead,');
        expect(html).toContain('John Doe checked in to Innovation Treehouse.');
        expect(html).toContain('📅 Friday, October 27');
        expect(html).toContain('🕐 2:30');
    });

    it('sends the household lead a check-out notice', async () => {
        await sendCheckinNotifications(1, 'checkout', null, AT);

        const html = htmlTo('jane@example.org');
        expect(html).toContain('👋 Household Member Departure');
        expect(html).toContain('John Doe checked out of Innovation Treehouse.');
    });

    it('indicates the check-in source when provided', async () => {
        await sendCheckinNotifications(1, 'checkin', 'SCANNER', AT);
        expect(htmlTo('jane@example.org')).toContain('via badge scan');

        send.mockClear();
        await sendCheckinNotifications(1, 'checkin', 'WEB', AT);
        expect(htmlTo('jane@example.org')).toContain('via the web app');

        send.mockClear();
        await sendCheckinNotifications(1, 'checkin', null, AT);
        expect(htmlTo('jane@example.org')).not.toContain('📍 via');
    });

    it('escapes HTML in lead and member names to prevent content injection', async () => {
        mockParticipant('<img src=x onerror=alert(1)>');
        mockLead('<script>evil()</script>');

        await sendCheckinNotifications(1, 'checkin', null, AT);

        const html = htmlTo('jane@example.org');
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<img src=x');
    });
});
