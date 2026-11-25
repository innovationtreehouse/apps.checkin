/**
 * @jest-environment node
 */
/**
 * Integration test for the Board's free-time concern on GET /api/membership-audit/compliance:
 * adults who aren't a household lead and checked in outside any program this membership
 * year with no agreement signed this year and none open.
 */

import { GET } from '@/app/api/membership-audit/compliance/route';
import { membershipYearAt } from '@/lib/membership/personAgreementTriggers';
import { orgToday } from '@/lib/appSettings';
import prisma from '@/lib/prisma';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const TAG = 'person-agreement-compliance-test';
const BOUNDARY_SEED = new Date('2000-09-01');
const NOW = new Date();
const ADULT_DOB = new Date('1990-01-01');
const MINOR_DOB = new Date(Date.UTC(NOW.getUTCFullYear() - 10, 0, 1));

type Row = { personId: number; reason: string; lastVisitAt?: string };

function get() {
    return GET(new Request('http://localhost:4000/api/membership-audit/compliance') as unknown as import('next/server').NextRequest);
}

async function makePerson(slug: string, householdId: number, data: {
    dateOfBirth?: Date | null;
    isDeclaredAdult?: boolean;
    isHouseholdLead?: boolean;
} = {}) {
    return prisma.person.create({
        data: {
            email: `${slug}-${TAG}@example.com`,
            name: `${slug} person`,
            householdId,
            dateOfBirth: data.dateOfBirth ?? null,
            isDeclaredAdult: data.isDeclaredAdult ?? false,
            isHouseholdLead: data.isHouseholdLead ?? false,
        },
    });
}

const freeTimeVisit = (personId: number, arrivedAt = NOW) =>
    prisma.visit.create({ data: { personId, arrivedAt, departedAt: arrivedAt, associatedEventId: null } });

async function cleanup() {
    const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const ids = hhs.map((h) => h.id);
    const people = await prisma.person.findMany({ where: { householdId: { in: ids } }, select: { id: true } });
    const pids = people.map((p) => p.id);
    await prisma.visit.deleteMany({ where: { personId: { in: pids } } });
    await prisma.event.deleteMany({ where: { name: { contains: TAG } } });
    await prisma.orgMembershipProcess.deleteMany({ where: { subjectPersonId: { in: pids } } });
    await prisma.person.deleteMany({ where: { id: { in: pids } } });
    await prisma.household.deleteMany({ where: { id: { in: ids } } });
}

describe('GET /api/membership-audit/compliance — free-time check-ins with no agreement', () => {
    let restoreBoardSettings: () => Promise<void> = async () => {};
    const id: Record<string, number> = {};
    let freeTime: Row[] = [];

    beforeAll(async () => {
        await cleanup();
        restoreBoardSettings = await snapshotBoardSettings();
        await prisma.boardSettings.upsert({
            where: { id: 1 },
            create: { id: 1, orgMembershipYearBoundary: BOUNDARY_SEED },
            update: { orgMembershipYearBoundary: BOUNDARY_SEED },
        });

        const hh = await prisma.household.create({ data: { name: `${TAG} family` } });
        const archived = await prisma.household.create({ data: { name: `${TAG} archived`, archivedAt: NOW } });
        const board = await makePerson('board', hh.id, { dateOfBirth: ADULT_DOB });
        await prisma.person.update({ where: { id: board.id }, data: { isBoardMember: true } });
        id.board = board.id;

        id.lead = (await makePerson('lead', hh.id, { dateOfBirth: ADULT_DOB, isHouseholdLead: true })).id;
        id.declared = (await makePerson('declared', hh.id, { isDeclaredAdult: true })).id;
        id.secondLead = (await makePerson('second-lead', hh.id, { dateOfBirth: ADULT_DOB, isHouseholdLead: true })).id;
        id.child = (await makePerson('child', hh.id, { dateOfBirth: ADULT_DOB })).id;
        id.signed = (await makePerson('signed', hh.id, { dateOfBirth: ADULT_DOB })).id;
        id.awaiting = (await makePerson('awaiting', hh.id, { dateOfBirth: ADULT_DOB })).id;
        id.lastYearOnly = (await makePerson('last-year-only', hh.id, { dateOfBirth: ADULT_DOB })).id;
        id.atProgram = (await makePerson('at-program', hh.id, { dateOfBirth: ADULT_DOB })).id;
        id.minor = (await makePerson('minor', hh.id, { dateOfBirth: MINOR_DOB })).id;
        id.unknownAge = (await makePerson('unknown-age', hh.id)).id;
        id.archived = (await makePerson('archived', archived.id, { isDeclaredAdult: true })).id;

        for (const who of ['lead', 'secondLead', 'declared', 'child', 'signed', 'awaiting', 'minor', 'unknownAge', 'archived']) await freeTimeVisit(id[who]);
        const thisYear = membershipYearAt(BOUNDARY_SEED, await orgToday(NOW));
        await freeTimeVisit(id.lastYearOnly, new Date(thisYear.start.getTime() - 30 * 86_400_000));
        const event = await prisma.event.create({ data: { name: `${TAG} session`, startAt: NOW, endAt: NOW } });
        await prisma.visit.create({ data: { personId: id.atProgram, arrivedAt: NOW, departedAt: NOW, associatedEventId: event.id } });
        await prisma.orgMembershipProcess.create({
            data: { kind: 'PERSON_AGREEMENT', subjectPersonId: id.signed, status: 'ACTIVE', contractSignedAt: NOW, stageEnteredAt: NOW },
        });
        await prisma.orgMembershipProcess.create({
            data: { kind: 'PERSON_AGREEMENT', subjectPersonId: id.awaiting, status: 'PENDING_EXTERNAL_ACTION' },
        });

        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: id.board, isBoardMember: true } });
        const body = await (await get()).json();
        freeTime = body.peopleFreeTimeWithoutAgreement;
    });

    afterAll(async () => {
        await cleanup();
        await restoreBoardSettings();
        await prisma.$disconnect();
    });

    const ids = (rows: Row[]) => new Set(rows.map((r) => r.personId));

    it('lists adults who are not a lead and checked in during free time with no agreement signed this year or open', () => {
        const listed = ids(freeTime);
        expect(listed.has(id.child)).toBe(true);
        expect(listed.has(id.declared)).toBe(true);
        expect(listed.has(id.lead)).toBe(false); // signs the household agreement
        expect(listed.has(id.secondLead)).toBe(false); // a partner made a lead
        expect(listed.has(id.unknownAge)).toBe(false);
        expect(listed.has(id.archived)).toBe(false);
        expect(listed.has(id.signed)).toBe(false); // signed this year
        expect(listed.has(id.awaiting)).toBe(false); // open, so on the awaiting-signature list instead
        expect(listed.has(id.lastYearOnly)).toBe(false); // no free-time visit this year
        expect(listed.has(id.atProgram)).toBe(false); // the visit was for a program session
        expect(listed.has(id.minor)).toBe(false);
        const row = freeTime.find((r) => r.personId === id.child);
        expect(row?.reason).toBe('FREE_TIME_WITHOUT_AGREEMENT');
        expect(row?.lastVisitAt).toBeDefined();
    });
});
