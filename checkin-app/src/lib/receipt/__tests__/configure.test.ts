import { configureReceipt, type ReceiptConfig } from '@checkin/receipt';
import prisma from '@/lib/prisma';
import { notifyFinanceAlert } from '@/lib/emailRecipients';
import { configureRuntime } from '../configure';

jest.mock('@aws-sdk/client-lambda', () => ({ LambdaClient: jest.fn(), InvokeCommand: jest.fn() }));
jest.mock('@checkin/receipt', () => ({
    configureReceipt: jest.fn(),
    createAnthropicOcr: jest.fn(),
    createGmailReader: jest.fn(() => ({ listRecent: jest.fn() })),
    fixtureOcr: {},
}));
jest.mock('@checkin/expense', () => ({ reimbursementStatus: {} }));
jest.mock('@checkin/workflow-mapping', () => ({ ingestReceipt: jest.fn() }));
jest.mock('@checkin/bulk-donation', () => ({ recordInKindDonor: jest.fn(), withdrawInKind: jest.fn() }));
jest.mock('@/lib/catalog/configure', () => ({ getOrg: jest.fn() }));
jest.mock('@/lib/emailRecipients', () => ({ notifyFinanceAlert: jest.fn() }));

const ADULT_DOB = new Date('1980-01-01');

function person(over: Record<string, unknown> = {}) {
    return {
        id: 7,
        name: 'Pat Example',
        email: 'pat@example.org',
        dateOfBirth: ADULT_DOB,
        isDeclaredAdult: false,
        householdId: 1,
        isHouseholdLead: true,
        canAccessStaging: false,
        roles: [],
        toolStatuses: [],
        programsLed: [],
        programVolunteers: [],
        household: { orgMembership: { status: 'ACTIVE', isVolunteerFamily: false } },
        ...over,
    };
}

function boundConfig(): ReceiptConfig {
    configureRuntime();
    const config = jest.mocked(configureReceipt).mock.calls.at(-1)?.[0];
    if (!config) throw new Error('configureReceipt was not called');
    return config;
}

describe('receipt runtime: mail intake bindings', () => {
    const env = { ...process.env };
    afterEach(() => {
        process.env = { ...env };
        jest.clearAllMocks();
    });

    it('attributes mail to the one adult member with that sign-in email', async () => {
        prisma.person.findMany = jest.fn().mockResolvedValue([person()]);
        const found = await boundConfig().people?.submitterByEmail('pat@example.org');
        expect(found).toEqual({ id: 7, name: 'Pat Example', firstName: 'Pat', lastName: 'Example', isAdult: true, raisedMailLimit: false });
        expect(jest.mocked(prisma.person.findMany).mock.calls[0][0]).toMatchObject({
            where: { mergedIntoId: null, accounts: { some: {} }, email: { equals: 'pat@example.org', mode: 'insensitive' } },
        });
    });

    it.each([
        ['nobody has the address', []],
        ['two people match', [person(), person({ id: 8 })]],
        ['the person is a youth with no role', [person({ dateOfBirth: new Date() })]],
        ['the household is not ACTIVE', [person({ household: { orgMembership: { status: 'REVOKED' } } })]],
        ['the household is DENIED', [person({ household: { orgMembership: { status: 'DENIED' } }, roles: [{ role: 'FINANCE' }] })]],
    ])('answers null when %s', async (_label, rows) => {
        prisma.person.findMany = jest.fn().mockResolvedValue(rows);
        expect(await boundConfig().people?.submitterByEmail('pat@example.org')).toBeNull();
    });

    it.each([
        ['a Board member', person({ roles: [{ role: 'BOARD' }] }), true],
        ['the lead of an active program', person({ programsLed: [{ id: 1, phase: 'RUNNING' }] }), true],
        ['the lead of finished programs only', person({ programsLed: [{ id: 1, phase: 'FINISHED' }] }), false],
        ['anyone else', person({ roles: [{ role: 'FINANCE' }] }), false],
    ])('gives %s the matching mail limit', async (_label, row, raised) => {
        prisma.person.findMany = jest.fn().mockResolvedValue([row]);
        expect(await boundConfig().people?.submitterByEmail('pat@example.org')).toMatchObject({ raisedMailLimit: raised });
    });

    it('leaves the mailbox unbound unless both the refresher and the address are set off-local', () => {
        process.env.CHECKIN_ENV = 'dev';
        delete process.env.GMAIL_REFRESHER_FN;
        process.env.RECEIPT_MAILBOX_ADDRESS = 'receipts@example.org';
        expect(boundConfig().mailbox).toBeUndefined();

        process.env.GMAIL_REFRESHER_FN = 'gmail-refresher';
        expect(boundConfig().mailbox).toBeDefined();

        process.env.CHECKIN_ENV = 'local';
        expect(boundConfig().mailbox).toBeUndefined();
    });

    it('alerts finance when mail intake stops holding mail', async () => {
        await boundConfig().alerts?.mailHoldCeilingReached({ orgId: 'org', unresolved: 500, refused: 3 });
        const [subject, html] = jest.mocked(notifyFinanceAlert).mock.calls[0];
        expect(subject).toMatch(/stopped holding mail/);
        expect(html).toContain('500');
        expect(html).toContain('3 more');
        expect(html).toContain('/receipts/mail');
    });
});
