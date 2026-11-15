/**
 * Runs the committed copy migration against seeded BoardSettings: the Board's
 * outreach and scholarship-ACK wording lands in EmailTemplate rows, the columns
 * stay as they were, and a row that already exists is kept.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import prisma from '@/lib/prisma';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';

const MIGRATION = join(__dirname, '../../../prisma/migrations/20261115140000_email_template_outreach_scholarship_copy/migration.sql');
const KEYS = ['outreach.opening', 'outreach.reminder', 'scholarship.ackMembership', 'scholarship.ackProgram'];
const COLUMNS = {
    outreachOpeningSubject: true, outreachOpeningBody: true, outreachReminderSubject: true, outreachReminderBody: true,
    scholarshipAckSubject: true, scholarshipAckMembershipBody: true, scholarshipAckProgramBody: true,
} as const;
type Columns = Record<keyof typeof COLUMNS, string | null>;
const BLANK = Object.fromEntries(Object.keys(COLUMNS).map((k) => [k, null])) as Columns;

let restoreBoardSettings: () => Promise<void> = async () => {};

beforeAll(async () => {
    restoreBoardSettings = await snapshotBoardSettings();
});
beforeEach(async () => {
    await prisma.emailTemplate.deleteMany({ where: { key: { in: KEYS } } });
});
afterAll(async () => {
    await prisma.emailTemplate.deleteMany({ where: { key: { in: KEYS } } });
    await restoreBoardSettings();
    await prisma.$disconnect();
});

// Runs the file's statements in one transaction, dropping its own BEGIN/COMMIT.
async function runMigration() {
    const statements = readFileSync(MIGRATION, 'utf8')
        .replace(/^--.*$/gm, '')
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s && s !== 'BEGIN' && s !== 'COMMIT');
    await prisma.$transaction(async (tx) => {
        for (const stmt of statements) await tx.$executeRawUnsafe(stmt);
    });
}

async function setColumns(data: Partial<Columns>) {
    await prisma.boardSettings.upsert({ where: { id: 1 }, create: { id: 1, ...BLANK, ...data }, update: { ...BLANK, ...data } });
}

async function rows() {
    const found = await prisma.emailTemplate.findMany({ where: { key: { in: KEYS } }, orderBy: { key: 'asc' }, select: { key: true, subject: true, body: true } });
    return Object.fromEntries(found.map((r) => [r.key, { subject: r.subject, body: r.body }]));
}

test('copies the wording into rows, turning {{actionWord}} into "renew", and leaves the columns', async () => {
    const columns = {
        outreachOpeningSubject: 'Time to {{actionWord}}',
        outreachOpeningBody: 'Hi {{name}}, please {{ actionWord }} by {{deadline}}: {{actionLink}}',
        outreachReminderSubject: 'Reminder',
        outreachReminderBody: null,
        scholarshipAckSubject: ' Got it: {{programName}} ',
        scholarshipAckMembershipBody: 'Membership {{programName}} received.',
        scholarshipAckProgramBody: 'Program {{programName}} received.',
    };
    await setColumns(columns);

    await runMigration();

    expect(await rows()).toEqual({
        'outreach.opening': { subject: 'Time to renew', body: 'Hi {{name}}, please renew by {{deadline}}: {{actionLink}}' },
        'outreach.reminder': { subject: 'Reminder', body: '' },
        'scholarship.ackMembership': { subject: 'Got it: ', body: 'Membership  received.' },
        'scholarship.ackProgram': { subject: 'Got it: {{programName}}', body: 'Program {{programName}} received.' },
    });
    expect(await prisma.boardSettings.findUniqueOrThrow({ where: { id: 1 }, select: COLUMNS })).toEqual(columns);
});

test('blank wording makes no row, and a row the Board already saved is kept', async () => {
    await setColumns({ outreachOpeningSubject: '  ', outreachOpeningBody: '\n', scholarshipAckProgramBody: 'From the columns' });
    await prisma.emailTemplate.create({ data: { key: 'scholarship.ackProgram', subject: 'Saved', body: 'Saved on the templates tab' } });

    await runMigration();

    expect(await rows()).toEqual({ 'scholarship.ackProgram': { subject: 'Saved', body: 'Saved on the templates tab' } });
});
