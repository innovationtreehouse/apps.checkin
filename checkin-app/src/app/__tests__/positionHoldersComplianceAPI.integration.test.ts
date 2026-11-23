/**
 * @jest-environment node
 */
/**
 * The compliance page's list of position holders: everyone holding a volunteer,
 * program-leader, bucket or role position, one row per person, judged against the
 * start of the membership year they serve in.
 */

import { GET } from '@/app/api/membership-audit/compliance/route';
import prisma from '@/lib/prisma';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';
import { checkValidFromForYear, type PositionHolderRow } from '@/lib/membership/positionHolders';
import { liveMembershipYear } from '@/lib/programYear';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

const TAG = 'position-holders-test';
const RECHECK_MONTHS = 27;
const BOUNDARY = new Date('2000-09-01');
const ROLES = ['SYSADMIN', 'BOARD', 'KEYHOLDER', 'BG_REVIEWER', 'OPERATIONS', 'INVENTORY_MANAGER', 'FINANCE', 'KEY_VOLUNTEER'] as const;
const DAY = 24 * 60 * 60 * 1000;

const get = () => GET(new Request('http://localhost:4000/api/membership-audit/compliance') as unknown as import('next/server').NextRequest);

describe('GET /api/membership-audit/compliance: positionHolders', () => {
    const liveYear = liveMembershipYear(BOUNDARY, new Date())!;
    const validFrom = checkValidFromForYear(BOUNDARY, RECHECK_MONTHS, liveYear);
    let householdId: number;
    let boardId: number;
    const ids: Record<string, number> = {};
    let restoreBoardSettings: () => Promise<void> = async () => {};

    const cleanup = async () => {
        const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const people = { person: { household: { name: { contains: TAG } } } };
        await prisma.personRole.deleteMany({ where: people });
        await prisma.programVolunteer.deleteMany({ where: people });
        await prisma.programInstance.deleteMany({ where: { program: { name: { contains: TAG } } } });
        await prisma.program.deleteMany({ where: { name: { contains: TAG } } });
        await prisma.budgetOwnerTreasurer.deleteMany({ where: { budgetOwner: { name: { contains: TAG } } } });
        await prisma.budgetOwner.deleteMany({ where: { name: { contains: TAG } } });
        await prisma.person.deleteMany({ where: { householdId: { in: hhs.map((h) => h.id) } } });
        await prisma.household.deleteMany({ where: { id: { in: hhs.map((h) => h.id) } } });
    };

    const person = async (slug: string, data: { lastBackgroundCheck?: Date; dateOfBirth?: Date } = {}) => {
        const p = await prisma.person.create({ data: { email: `${slug}-${TAG}@example.com`, name: `${slug} ${TAG}`, householdId, isDeclaredAdult: !data.dateOfBirth, ...data } });
        ids[slug] = p.id;
        return p.id;
    };

    beforeAll(async () => {
        await cleanup();
        restoreBoardSettings = await snapshotBoardSettings();
        await prisma.boardSettings.upsert({
            where: { id: 1 },
            create: { id: 1, bgRecheckMonths: RECHECK_MONTHS, orgMembershipYearBoundary: BOUNDARY },
            update: { bgRecheckMonths: RECHECK_MONTHS, orgMembershipYearBoundary: BOUNDARY },
        });
        householdId = (await prisma.household.create({ data: { name: `${TAG} household` } })).id;
        boardId = (await prisma.person.create({ data: { email: `board-${TAG}@example.com`, name: 'Board Actor', isBoardMember: true, household: { create: { name: `${TAG} board` } } } })).id;

        const startAt = new Date(Date.now() - 30 * DAY);
        const endAt = new Date(Date.now() + 365 * DAY);
        const program = await prisma.program.create({ data: { name: `This year ${TAG}`, appliesToYear: liveYear, startAt, endAt } });
        const nextYear = await prisma.program.create({ data: { name: `Next year ${TAG}`, appliesToYear: liveYear + 1, startAt, endAt, leadMentorId: await person('leader', { lastBackgroundCheck: validFrom }) } });
        const ended = await prisma.program.create({ data: { name: `Ended ${TAG}`, appliesToYear: liveYear, startAt: new Date(Date.now() - 60 * DAY), endAt: new Date(Date.now() - 2 * DAY) } });

        await prisma.programVolunteer.create({ data: { programId: program.id, personId: await person('volunteer') } });
        await prisma.programVolunteer.create({ data: { programId: program.id, personId: await person('core', { lastBackgroundCheck: validFrom }), isCore: true } });
        await prisma.programInstance.create({ data: { programId: nextYear.id, name: 'Run A', leadMentorId: await person('runLeader', { lastBackgroundCheck: validFrom }) } });
        await prisma.programVolunteer.create({ data: { programId: ended.id, personId: await person('endedVolunteer') } });
        const tenYearsAgo = new Date(Date.UTC(new Date().getUTCFullYear() - 10, 0, 1));
        await prisma.programVolunteer.create({ data: { programId: program.id, personId: await person('minor', { dateOfBirth: tenYearsAgo }) } });

        const bucket = await prisma.budgetOwner.create({ data: { name: `Bucket ${TAG}`, ownerId: await person('owner', { lastBackgroundCheck: validFrom }) } });
        await prisma.budgetOwnerTreasurer.create({ data: { budgetOwnerId: bucket.id, personId: await person('treasurer', { lastBackgroundCheck: validFrom }) } });

        const multi = await person('multi', { lastBackgroundCheck: validFrom });
        for (const role of ROLES) await prisma.personRole.create({ data: { personId: multi, role } });
        await prisma.programVolunteer.create({ data: { programId: program.id, personId: multi } });

        await prisma.personRole.create({ data: { personId: await person('dayBefore', { lastBackgroundCheck: new Date(validFrom.getTime() - DAY) }), role: 'KEYHOLDER' } });
    });

    afterAll(async () => {
        await cleanup();
        await restoreBoardSettings();
    });

    const rows = async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
        const res = await get();
        expect(res.status).toBe(200);
        const { positionHolders } = (await res.json()) as { positionHolders: PositionHolderRow[] };
        return new Map(positionHolders.filter((r) => r.householdId === householdId).map((r) => [r.personId, r]));
    };

    it('lists every position kind', async () => {
        const kinds = new Set([...(await rows()).values()].flatMap((r) => r.positions.map((p) => p.kind)));
        expect([...kinds].sort()).toEqual(['VOLUNTEER', 'CORE_VOLUNTEER', 'PROGRAM_LEADER', 'RUN_LEADER', 'BUCKET_OWNER', 'BUCKET_TREASURER', ...ROLES].sort());
    });

    it('gives a person holding several positions one row listing them all', async () => {
        const multi = (await rows()).get(ids.multi)!;
        expect(multi.positions.map((p) => p.kind).sort()).toEqual(['VOLUNTEER', ...ROLES].sort());
        expect(multi.standing).toBe('CURRENT');
    });

    it('judges a check at the start of the year served: on the edge is current, a day before is not', async () => {
        const byId = await rows();
        expect(byId.get(ids.core)?.standing).toBe('CURRENT');
        expect(byId.get(ids.owner)?.standing).toBe('CURRENT');
        expect(byId.get(ids.treasurer)?.standing).toBe('CURRENT');
        expect(byId.get(ids.dayBefore)?.standing).toBe('NOT_CURRENT');
        expect(byId.get(ids.volunteer)?.standing).toBe('NO_CHECK');
    });

    it("judges a next-year program's leaders against next year's start", async () => {
        const byId = await rows();
        expect(byId.get(ids.leader)).toMatchObject({ year: liveYear + 1, standing: 'NOT_CURRENT' });
        expect(byId.get(ids.runLeader)).toMatchObject({ year: liveYear + 1, standing: 'NOT_CURRENT' });
    });

    it('leaves out an ended program and a minor', async () => {
        const byId = await rows();
        expect(byId.has(ids.endedVolunteer)).toBe(false);
        expect(byId.has(ids.minor)).toBe(false);
    });

    it('refuses a caller who is neither Board nor sysadmin, even one holding positions', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: ids.dayBefore, isBoardMember: false, isSysadmin: false, isKeyholder: true } });
        expect((await get()).status).toBe(403);
    });
});
