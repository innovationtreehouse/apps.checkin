import { configureReceipt, type ReceiptConfig } from '@checkin/receipt';
import type { Session } from 'next-auth';
import prisma from '@/lib/prisma';
import { notifyFinanceAlert } from '@/lib/emailRecipients';
import { expenseOutcomes } from '@checkin/expense';
import { receivingOutcomes } from '@checkin/workflow-mapping';
import { giftOutcomes } from '@checkin/bulk-donation';
import { sessionUser } from '@/lib/components/host';
import { configureRuntime } from '../configure';

jest.mock('@aws-sdk/client-lambda', () => ({ LambdaClient: jest.fn(), InvokeCommand: jest.fn() }));
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn() }));
jest.mock('@checkin/receipt', () => ({
    configureReceipt: jest.fn(),
    createAnthropicOcr: jest.fn(),
    createGmailReader: jest.fn(() => ({ listRecent: jest.fn() })),
    fixtureOcr: {},
}));
jest.mock('@checkin/expense', () => ({ reimbursementStatus: {}, expenseOutcomes: { forReceipts: jest.fn() } }));
jest.mock('@checkin/workflow-mapping', () => ({ ingestReceipt: jest.fn(), receivingOutcomes: jest.fn() }));
jest.mock('@checkin/bulk-donation', () => ({ recordInKindDonor: jest.fn(), withdrawInKind: jest.fn(), giftOutcomes: jest.fn() }));
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
        mailAliases: [],
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
            where: {
                mergedIntoId: null,
                accounts: { some: {} },
                OR: [{ email: { equals: 'pat@example.org', mode: 'insensitive' } }, { mailAliases: { some: { address: 'pat@example.org', approvedAt: { not: null } } } }],
            },
        });
    });

    it('resolves a Treehouse-account staff member from a personal alias, taking the org claim from the sign-in email', async () => {
        const staff = person({ email: 'staff@innovationtreehouse.org', mailAliases: [{ id: 1 }], household: { orgMembership: null } });
        prisma.person.findMany = jest.fn().mockResolvedValue([staff]);
        expect(await boundConfig().people?.submitterByEmail('staff.personal@gmail.com')).toMatchObject({ id: 7 });
    });

    it('lowercases a legacy mixed-case sign-in email for the org claim', async () => {
        const staff = person({ email: 'Staff@InnovationTreehouse.org', household: { orgMembership: null } });
        prisma.person.findMany = jest.fn().mockResolvedValue([staff]);
        expect(await boundConfig().people?.submitterByEmail('staff@innovationtreehouse.org')).toMatchObject({ id: 7 });
    });

    it('answers null for an address that is neither the sign-in email nor an approved alias', async () => {
        prisma.person.findMany = jest.fn().mockResolvedValue([person({ email: 'other@example.org' })]);
        expect(await boundConfig().people?.submitterByEmail('pat@example.org')).toBeNull();
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
        const [subject, html] = jest.mocked(notifyFinanceAlert).mock.calls[0];
        expect(subject).toMatch(/about to be missed/);
        expect(html).toContain('4 message(s)');
        expect(html).toContain('25 Oct 2026');
        expect(html).toContain('/receipts/mail');
    });

    it('alerts finance when the mailbox cannot be listed', async () => {
        await boundConfig().alerts?.mailListingFailed({ orgId: 'org' });
        const [subject, html] = jest.mocked(notifyFinanceAlert).mock.calls[0];
        expect(subject).toMatch(/could not be read/);
        expect(html).toContain('/receipts/mail');
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

describe('receipt runtime: purchase outcome binding', () => {
    it('joins receiving, the expense and the gift for each receipt asked about', async () => {
        jest.mocked(receivingOutcomes).mockResolvedValue(new Map([['r-1', 'received'], ['r-2', 'waiting']]));
        jest.mocked(expenseOutcomes.forReceipts).mockResolvedValue(new Map([['r-1', { status: 'line_rejected', notes: ['Not a program cost'] }]]));
        jest.mocked(giftOutcomes).mockResolvedValue(new Map());
        const answer = await boundConfig().purchaseOutcomes?.forReceipts(['r-1', 'r-2', 'r-3']);
        expect(answer).toEqual(
            new Map([
                ['r-1', { receiving: 'received', money: { status: 'line_rejected', notes: ['Not a program cost'] }, gift: null }],
                ['r-2', { receiving: 'waiting', money: null, gift: null }],
                ['r-3', { receiving: null, money: null, gift: null }],
            ]),
        );
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
