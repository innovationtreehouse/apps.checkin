/**
 * @jest-environment node
 */
/**
 * GET /api/people/search?roster=active — the population badge display names are
 * disambiguated against (#1625).
 *
 * The page-level test proves the printed name doesn't move when the operator ticks a
 * checkbox or types, but it does that against a mocked server. These are the server-side
 * halves of the same claim: roster mode returns ACTIVE members only, excludes merge
 * tombstones, and — the part the whole fix rests on — ignores `q` entirely, so a search
 * cannot shrink the population a name is computed from.
 */

import { GET } from '@/app/api/people/search/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const TAG = 'roster-1625';

describe('GET /api/people/search?roster=active', () => {
    let adminId: number;

    let prevBoundary: Date | null = null;
    // setBoundary upserts, so it can CREATE the singleton. A null prevBoundary can't tell
    // "row absent" from "row present, value null" — record it, or teardown leaves behind a
    // row that any suite asserting on an unconfigured install would inherit.
    let boardSettingsExisted = false;

    const shiftMonths = (from: Date, months: number) => {
        const d = new Date(from);
        d.setUTCMonth(d.getUTCMonth() + months);
        return d;
    };

    // Anchor the renewal window to the run date rather than a fixed calendar date, so
    // the suite means the same thing whenever CI runs it: a boundary one month out puts
    // `now` inside the 2-month lead window, with settledSince about a month behind.
    const now = new Date();
    const BOUNDARY = shiftMonths(now, 1);
    const INSIDE_WINDOW = shiftMonths(now, 0);
    const BEFORE_WINDOW = shiftMonths(now, -6);

    async function setBoundary(boundary: Date | null) {
        await prisma.boardSettings.upsert({
            where: { id: 1 },
            create: { id: 1, orgMembershipYearBoundary: boundary },
            update: { orgMembershipYearBoundary: boundary },
        });
    }

    /** Delete this file's people, their processes and memberships, then the empty households. */
    async function wipe() {
        const rows = await prisma.person.findMany({
            where: { email: { contains: TAG } },
            select: { householdId: true },
        });
        const householdIds = [...new Set(rows.map(r => r.householdId).filter((id): id is number => id != null))];
        if (householdIds.length) {
            // Processes first: the OrgMembership FK is onDelete: Restrict.
            await prisma.orgMembershipProcess.deleteMany({
                where: { orgMembership: { householdId: { in: householdIds } } },
            });
            await prisma.orgMembership.deleteMany({ where: { householdId: { in: householdIds } } });
        }
        await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
        if (householdIds.length) {
            await prisma.household.deleteMany({ where: { id: { in: householdIds }, householdMembers: { none: {} } } });
        }
    }

    /** One person in their own household, whose membership sits at `status` and carries
     *  `process` (the membership-year settlement, or the lack of one). */
    const makePerson = (
        name: string,
        slug: string,
        status: 'ACTIVE' | 'NONE',
        process?: { kind: 'INITIAL' | 'RENEWAL'; status: 'ACTIVE' | 'ARCHIVED'; stageEnteredAt: Date },
    ) =>
        prisma.person.create({
            data: {
                name,
                email: `${slug}-${TAG}@example.com`,
                household: {
                    create: {
                        name: `HH ${slug} ${TAG}`,
                        orgMembership: { create: { status, ...(process ? { processes: { create: process } } : {}) } },
                    },
                },
            },
        });

    beforeAll(async () => {
        await wipe();
        const existing = await prisma.boardSettings.findUnique({
            where: { id: 1 },
            select: { orgMembershipYearBoundary: true },
        });
        boardSettingsExisted = existing !== null;
        prevBoundary = existing?.orgMembershipYearBoundary ?? null;
        await setBoundary(BOUNDARY);

        const admin = await makePerson('Admin Roster', 'admin', 'NONE');
        await prisma.person.update({ where: { id: admin.id }, data: { isSysadmin: true } });
        adminId = admin.id;

        // An ACTIVE member who also holds a sysadmin login. The roster must exclude
        // her on the ROLE — membership status can't be what catches her. The exclusion
        // reads the PersonRole table, so grant the role row (the mirror column alone
        // would not be seen).
        const sue = await makePerson('Sysadmin Sue', 'sue', 'ACTIVE');
        await prisma.personRole.create({ data: { personId: sue.id, role: 'SYSADMIN' } });
        await prisma.person.update({ where: { id: sue.id }, data: { isSysadmin: true } });

        await makePerson('John Smith', 'smith', 'ACTIVE');
        await makePerson('John Doe', 'doe', 'ACTIVE');
        await makePerson('John Lapsed', 'lapsed', 'NONE');

        // ACTIVE but merged away: a tombstone row that LIVE_PERSON must keep out.
        const ghost = await makePerson('John Ghost', 'ghost', 'ACTIVE');
        await prisma.person.update({ where: { id: ghost.id }, data: { mergedIntoId: adminId } });

        // The #1628 cohort. Every one of these is an ACTIVE member — status cannot be
        // what separates them, only whether they settled the current cycle.
        await makePerson('Renewed Rita', 'rita', 'ACTIVE', { kind: 'RENEWAL', status: 'ACTIVE', stageEnteredAt: INSIDE_WINDOW });
        await makePerson('Joined Jo', 'jo', 'ACTIVE', { kind: 'INITIAL', status: 'ACTIVE', stageEnteredAt: INSIDE_WINDOW });
        await makePerson('Stale Sam', 'sam', 'ACTIVE', { kind: 'RENEWAL', status: 'ACTIVE', stageEnteredAt: BEFORE_WINDOW });
        await makePerson('Archived Al', 'al', 'ACTIVE', { kind: 'RENEWAL', status: 'ARCHIVED', stageEnteredAt: INSIDE_WINDOW });

        (getServerSession as jest.Mock).mockResolvedValue({
            user: { id: adminId, isSysadmin: true, isBoardMember: false },
        });
    });

    afterAll(async () => {
        await wipe();
        if (boardSettingsExisted) await setBoundary(prevBoundary);
        else await prisma.boardSettings.delete({ where: { id: 1 } });
    });

    const rosterRows = async (query: string) => {
        const req = new Request(`http://localhost:4000/api/people/search?${query}`);
        const res = await GET(req as unknown as Parameters<typeof GET>[0]);
        expect(res.status).toBe(200);
        const { people } = await res.json();
        return people as { id: number; name: string; year: string | null }[];
    };

    const roster = async (query: string) =>
        (await rosterRows(query))
            .filter(p => ['John Smith', 'John Doe', 'John Lapsed', 'John Ghost'].includes(p.name))
            .map(p => p.name)
            .sort();

    /** The year each #1628 fixture is handed, keyed by name. */
    const years = async () => {
        const rows = await rosterRows('roster=active');
        const names = ['Renewed Rita', 'Joined Jo', 'Stale Sam', 'Archived Al', 'John Smith'];
        return Object.fromEntries(rows.filter(p => names.includes(p.name)).map(p => [p.name, p.year]));
    };

    it('returns ACTIVE members only, excluding non-members and merge tombstones', async () => {
        expect(await roster('roster=active')).toEqual(['John Doe', 'John Smith']);
    });

    it('ignores `q`, so searching cannot shrink the population a printed name derives from', async () => {
        expect(await roster('roster=active&q=Smith')).toEqual(['John Doe', 'John Smith']);
    });

    it('still searches normally without the roster flag', async () => {
        expect(await roster('q=John Smith')).toEqual(['John Smith']);
    });

    it('excludes sysadmin logins from the roster, even as ACTIVE members', async () => {
        // Admin logins never wear a badge by default — the role, not membership
        // status, is what removes her, and it also keeps her out of printed-name
        // disambiguation.
        const names = (await rosterRows('roster=active')).map(p => p.name);
        expect(names).toContain('John Smith');
        expect(names).not.toContain('Sysadmin Sue');
    });

    describe('the membership year (#1628)', () => {
        it('goes only to households that settled this renewal cycle', async () => {
            const y = await years();
            expect(y['Renewed Rita']).toMatch(/^\d{4}-\d{4}$/);
            // ACTIVE members every one of them, and none has settled this cycle.
            expect(y['Stale Sam']).toBeNull();
            expect(y['Archived Al']).toBeNull();
            expect(y['John Smith']).toBeNull();
        });

        it('counts an INITIAL settled this cycle, not just a RENEWAL', async () => {
            // A family that joined this cycle has paid for this year exactly as one that
            // renewed. A `kind: "RENEWAL"` filter would blank every new member's badge.
            const y = await years();
            expect(y['Joined Jo']).toMatch(/^\d{4}-\d{4}$/);
            expect(y['Joined Jo']).toBe(y['Renewed Rita']);
        });

        it('with no boundary configured, nobody has a year', async () => {
            await setBoundary(null);
            try {
                const y = await years();
                // Named explicitly: `every` over an empty object would pass vacuously.
                expect(y).toEqual({
                    'Renewed Rita': null, 'Joined Jo': null, 'Stale Sam': null,
                    'Archived Al': null, 'John Smith': null,
                });
            } finally {
                await setBoundary(BOUNDARY);
            }
        });
    });
});
