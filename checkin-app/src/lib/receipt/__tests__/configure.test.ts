import { configureReceipt, type ReceiptConfig } from '@checkin/receipt';
import type { Session } from 'next-auth';
import prisma from '@/lib/prisma';
import { notifyFinanceAlert } from '@/lib/emailRecipients';
import { sessionUser } from '@/lib/components/host';
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
jest.mock('@/lib/components/host', () => ({ getOrg: jest.fn(), sessionUser: jest.fn() }));
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
        process.env.RECEIPT_PROD_MAILBOX_ADDRESS = 'real@example.org';
        delete process.env.GMAIL_REFRESHER_FN;
        process.env.RECEIPT_MAILBOX_ADDRESS = 'receipts@example.org';
        expect(boundConfig().mailbox).toBeUndefined();

        process.env.GMAIL_REFRESHER_FN = 'gmail-refresher';
        expect(boundConfig().mailbox).toBeDefined();

        process.env.CHECKIN_ENV = 'local';
        expect(boundConfig().mailbox).toBeUndefined();
    });

    it.each([['dev'], ['stg']])('on %s, refuses the real mailbox and binds only a different one', (env) => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        process.env.CHECKIN_ENV = env;
        process.env.GMAIL_REFRESHER_FN = 'gmail-refresher';
        process.env.RECEIPT_MAILBOX_ADDRESS = 'receipts@example.org';
        delete process.env.RECEIPT_PROD_MAILBOX_ADDRESS;
        expect(boundConfig().mailbox).toBeUndefined();

        process.env.RECEIPT_PROD_MAILBOX_ADDRESS = ' Receipts@Example.org ';
        expect(boundConfig().mailbox).toBeUndefined();

        process.env.RECEIPT_PROD_MAILBOX_ADDRESS = 'real@example.org';
        expect(boundConfig().mailbox).toBeDefined();
    });

    it.each([['unset', undefined], ['blank', ''], ['misspelled', 'production'], ['wrong case', 'Prod']])(
        'binds no mailbox when CHECKIN_ENV is %s, though it reads as prod',
        (_label, value) => {
            const error = jest.spyOn(console, 'error').mockImplementation(() => {});
            if (value === undefined) delete process.env.CHECKIN_ENV;
            else process.env.CHECKIN_ENV = value;
            process.env.GMAIL_REFRESHER_FN = 'gmail-refresher';
            process.env.RECEIPT_MAILBOX_ADDRESS = 'receipts@example.org';
            delete process.env.RECEIPT_PROD_MAILBOX_ADDRESS;
            expect(boundConfig().mailbox).toBeUndefined();
            expect(error).toHaveBeenCalledWith(expect.stringContaining('CHECKIN_ENV must be prod, dev or stg'));
        },
    );

    it('binds the real mailbox on prod without the prod-mailbox setting', () => {
        process.env.CHECKIN_ENV = 'prod';
        process.env.GMAIL_REFRESHER_FN = 'gmail-refresher';
        process.env.RECEIPT_MAILBOX_ADDRESS = 'receipts@example.org';
        delete process.env.RECEIPT_PROD_MAILBOX_ADDRESS;
        expect(boundConfig().mailbox).toBeDefined();
    });

    it('attributes mail only to the exact sign-in email, never a pattern-like near match', async () => {
        prisma.person.findMany = jest.fn().mockResolvedValue([person({ email: 'pat_x@example.org' })]);
        expect(await boundConfig().people?.submitterByEmail('patax@example.org')).toBeNull();
        prisma.person.findMany = jest.fn().mockResolvedValue([person({ email: 'Pat@Example.org' })]);
        expect(await boundConfig().people?.submitterByEmail('pat@example.org')).toMatchObject({ id: 7 });
    });

    it('alerts finance when mail is about to leave the window unread', async () => {
        await boundConfig().alerts?.mailAgingOut({ orgId: 'org', messages: 4, oldestReceivedAt: new Date('2026-10-25T09:00:00Z') });
        const [key, values] = jest.mocked(notifyFinanceAlert).mock.calls[0];
        expect(key).toBe('finance.receiptMailAgeing');
        expect(values).toMatchObject({ messages: '4', since: expect.stringContaining('25 Oct 2026'), actionLink: expect.stringContaining('/receipts/mail') });
    });

    it('alerts finance when mail intake stops holding mail', async () => {
        await boundConfig().alerts?.mailHoldCeilingReached({ orgId: 'org', unresolved: 500, refused: 3 });
        const [key, values] = jest.mocked(notifyFinanceAlert).mock.calls[0];
        expect(key).toBe('finance.receiptMailCeiling');
        expect(values).toMatchObject({ unresolved: '500', refused: '3', actionLink: expect.stringContaining('/receipts/mail') });
    });
});

describe('receipt runtime: reimbursee bindings', () => {
    afterEach(() => jest.clearAllMocks());

    const adult = { id: 8, name: 'Sam Lee', dateOfBirth: ADULT_DOB, isDeclaredAdult: false };
    const minor = { id: 9, name: 'Sam Kid', dateOfBirth: new Date(), isDeclaredAdult: false };
    const unknownAge = { id: 10, name: 'Sam Who', dateOfBirth: null, isDeclaredAdult: false };
    // No household or membership is read: someone without an account is named like any adult.
    const declaredNonMember = { id: 11, name: 'Sam Guest', dateOfBirth: null, isDeclaredAdult: true };

    it('searches live people by name and offers only known adults, members or not, as id and name', async () => {
        prisma.person.findMany = jest.fn().mockResolvedValue([adult, minor, unknownAge, declaredNonMember]);
        expect(await boundConfig().reimbursees?.search('sam', 20)).toEqual([{ id: 8, name: 'Sam Lee' }, { id: 11, name: 'Sam Guest' }]);
        const query = jest.mocked(prisma.person.findMany).mock.calls[0][0];
        expect(query).toMatchObject({ where: { mergedIntoId: null, name: { contains: 'sam', mode: 'insensitive' } } });
        expect(Object.keys(query?.where ?? {}).sort()).toEqual(['mergedIntoId', 'name']);
    });

    it('caps the search after dropping anyone not known to be an adult', async () => {
        prisma.person.findMany = jest.fn().mockResolvedValue([minor, adult, declaredNonMember]);
        expect(await boundConfig().reimbursees?.search('sam', 1)).toEqual([{ id: 8, name: 'Sam Lee' }]);
    });

    it.each([
        ['an adult', adult, true],
        ['a non-member declared adult', declaredNonMember, true],
        ['a minor', minor, false],
        ['someone of unknown age', unknownAge, false],
    ])('names %s by id with whether they are an adult', async (_label, row, isAdult) => {
        prisma.person.findFirst = jest.fn().mockResolvedValue(row);
        expect(await boundConfig().reimbursees?.byId(row.id)).toEqual({ id: row.id, name: row.name, isAdult });
    });

    it('names nobody by id once their record is merged away', async () => {
        prisma.person.findFirst = jest.fn().mockResolvedValue(null);
        expect(await boundConfig().reimbursees?.byId(8)).toBeNull();
        expect(jest.mocked(prisma.person.findFirst).mock.calls[0][0]).toMatchObject({ where: { id: 8, mergedIntoId: null } });
    });
});

describe('receipt runtime: mailed receipt acknowledgements', () => {
    afterEach(() => jest.clearAllMocks());

    it("gives a live person's sign-in email and name", async () => {
        prisma.person.findFirst = jest.fn().mockResolvedValue({ email: 'pat@example.org', name: 'Pat Example' });
        expect(await boundConfig().replies?.contactOf(7)).toEqual({ email: 'pat@example.org', name: 'Pat Example' });
        expect(jest.mocked(prisma.person.findFirst).mock.calls[0][0]).toMatchObject({ where: { id: 7, mergedIntoId: null, accounts: { some: {} } } });
    });

    it('gives nobody for a person without an email, without a sign-in, or merged away', async () => {
        prisma.person.findFirst = jest.fn().mockResolvedValue({ email: null, name: 'Kid' });
        expect(await boundConfig().replies?.contactOf(7)).toBeNull();
        prisma.person.findFirst = jest.fn().mockResolvedValue(null);
        expect(await boundConfig().replies?.contactOf(7)).toBeNull();
    });
});

describe('receipt runtime: principal', () => {
    afterEach(() => jest.clearAllMocks());

    it('refuses a session checkin refuses, without reading the Person', async () => {
        jest.mocked(sessionUser).mockResolvedValue(null);
        prisma.person.findFirst = jest.fn();
        expect(await boundConfig().auth?.getPrincipal()).toBeNull();
        expect(prisma.person.findFirst).not.toHaveBeenCalled();
    });

    it('takes names and adulthood from the live Person, roles from the session', async () => {
        jest.mocked(sessionUser).mockResolvedValue({ id: 7, isBoardMember: true } as Session['user']);
        prisma.person.findFirst = jest.fn().mockResolvedValue({ name: 'Pat Example', dateOfBirth: ADULT_DOB, isDeclaredAdult: null });
        expect(await boundConfig().auth?.getPrincipal()).toEqual({
            id: 7,
            name: 'Pat Example',
            firstName: 'Pat',
            lastName: 'Example',
            isAdult: true,
            isBoardMember: true,
            addsPeople: true,
        });
        expect(jest.mocked(prisma.person.findFirst).mock.calls[0][0]).toMatchObject({ where: { id: 7, mergedIntoId: null } });
    });

    it('refuses a session whose Person is gone', async () => {
        jest.mocked(sessionUser).mockResolvedValue({ id: 7 } as Session['user']);
        prisma.person.findFirst = jest.fn().mockResolvedValue(null);
        expect(await boundConfig().auth?.getPrincipal()).toBeNull();
    });
});
