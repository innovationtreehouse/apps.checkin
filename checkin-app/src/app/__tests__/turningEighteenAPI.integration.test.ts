/**
 * @jest-environment node
 */
/**
 * Integration tests for the member-year 18+ roster
 * (GET /api/membership-audit/turning-18). The response passes through the
 * security stripper, which drops any bag key or field the registry entry does
 * not classify — so these assert the SHAPE survives (dateOfBirth, the nested
 * household and program, and the board's year boundary), not just the rows.
 */

import { GET } from '@/app/api/membership-audit/turning-18/route';
import prisma from '@/lib/prisma';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

const TAG = 'turning-18-api-test';
// Boundary month/day is all that matters; the stored year is arbitrary.
const BOUNDARY = new Date('2000-09-01T00:00:00Z');

function get() {
    return GET(new Request('http://localhost:4000/api/membership-audit/turning-18', {
        method: 'GET',
    }) as unknown as import('next/server').NextRequest);
}

type Row = {
    id: number;
    name: string | null;
    dateOfBirth: string | null;
    household: { id: number; name: string | null } | null;
    programParticipants: { program: { id: number; name: string } }[];
};

describe('GET /api/membership-audit/turning-18', () => {
    let boardId: number;
    let householdId: number;
    let programId: number;
    let adultId: number;
    let youthId: number;
    let leadId: number;
    let unknownDobId: number;
    let declaredAdultId: number;
    let restoreBoardSettings: () => Promise<void>;

    const cleanup = async () => {
        const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const hhIds = hhs.map(h => h.id);
        const people = await prisma.person.findMany({ where: { householdId: { in: hhIds } }, select: { id: true } });
        await prisma.programParticipant.deleteMany({ where: { personId: { in: people.map(p => p.id) } } });
        await prisma.program.deleteMany({ where: { name: { contains: TAG } } });
        await prisma.person.deleteMany({ where: { householdId: { in: hhIds } } });
        await prisma.household.deleteMany({ where: { id: { in: hhIds } } });
    };

    beforeAll(async () => {
        await cleanup();

        restoreBoardSettings = await snapshotBoardSettings();
        await prisma.boardSettings.upsert({
            where: { id: 1 },
            update: { orgMembershipYearBoundary: BOUNDARY },
            create: { id: 1, orgMembershipYearBoundary: BOUNDARY },
        });

        const household = await prisma.household.create({ data: { name: `${TAG} household` } });
        householdId = household.id;
        const program = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `${TAG} program`, phase: 'RUNNING' } });
        programId = program.id;

        const board = await prisma.person.create({
            data: { name: `${TAG} board`, email: `board-${TAG}@example.com`, householdId, isBoardMember: true },
        });
        boardId = board.id;

        // Comfortably an adult at both boundaries, and enrolled in a program.
        const adult = await prisma.person.create({
            data: { name: `${TAG} adult`, householdId, dateOfBirth: new Date('2000-01-01T00:00:00Z') },
        });
        adultId = adult.id;
        await prisma.programParticipant.create({ data: { programId, personId: adultId } });

        // A 10-year-old: below the cutoff at both boundaries, so never on the roster.
        const youth = await prisma.person.create({
            data: { name: `${TAG} youth`, householdId, dateOfBirth: new Date('2016-01-01T00:00:00Z') },
        });
        youthId = youth.id;

        // An adult who IS a household lead — the signer, deliberately excluded.
        const lead = await prisma.person.create({
            data: { name: `${TAG} lead`, householdId, dateOfBirth: new Date('1980-01-01T00:00:00Z') },
        });
        leadId = lead.id;
        await prisma.person.update({ where: { id: leadId }, data: { isHouseholdLead: true } });

        // No DOB, no 25+ declaration: age unknown, could be turning 18.
        const unknown = await prisma.person.create({
            data: { name: `${TAG} unknown dob`, householdId, dateOfBirth: null, isDeclaredAdult: false },
        });
        unknownDobId = unknown.id;

        // No DOB because a lead declared them 25+ — nothing to chase, stays off the roster.
        const declared = await prisma.person.create({
            data: { name: `${TAG} declared adult`, householdId, dateOfBirth: null, isDeclaredAdult: true },
        });
        declaredAdultId = declared.id;
    });

    afterAll(async () => {
        await cleanup();
        await restoreBoardSettings();
        await prisma.$disconnect();
    });

    beforeEach(() => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
    });

    it('returns the adult with dateOfBirth, household and program surviving the stripper', async () => {
        const res = await get();
        expect(res.status).toBe(200);
        const body = await res.json();

        expect(body.BoardSettings.orgMembershipYearBoundary).toBe(BOUNDARY.toISOString());

        const row = (body.Person as Row[]).find(p => p.id === adultId);
        expect(row).toBeDefined();
        // The page derives both as-of ages from this field; if the registry's
        // 'everyones:personal' grant ever narrows, it lands here as null/absent.
        expect(row!.dateOfBirth).toBe('2000-01-01T00:00:00.000Z');
        expect(row!.household?.id).toBe(householdId);
        expect(row!.programParticipants.map(pp => pp.program.id)).toEqual([programId]);
    });

    it('excludes household leads and anyone under 18 at the next boundary', async () => {
        const res = await get();
        const ids = ((await res.json()).Person as Row[]).map(p => p.id);
        expect(ids).not.toContain(leadId);
        expect(ids).not.toContain(youthId);
    });

    it('includes the unknown-age people with a null DOB, and excludes the declared 25+', async () => {
        const res = await get();
        const rows = (await res.json()).Person as Row[];

        // NULL never satisfies the SQL age cutoff, so this arm is the only thing
        // keeping a birthdate-less 17-year-old visible to the board.
        const unknown = rows.find(p => p.id === unknownDobId);
        expect(unknown).toBeDefined();
        expect(unknown!.dateOfBirth).toBeNull();

        expect(rows.map(p => p.id)).not.toContain(declaredAdultId);
    });

    it('forbids a non-board caller', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adultId, isBoardMember: false } });
        expect((await get()).status).toBe(403);
    });
});
