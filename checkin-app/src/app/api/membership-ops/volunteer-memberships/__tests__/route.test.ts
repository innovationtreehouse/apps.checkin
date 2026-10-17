/**
 * @jest-environment node
 */
/**
 * Unit tests for GET /api/membership-ops/volunteer-memberships — the roster's
 * row assembly: how a volunteer OrgMembership and a VolunteerDesignation each
 * map to a status, and how designations resolve to households through the same
 * canonicalized household-lead rule that grants the fee. The deny paths
 * (401 anon / 403 plain member) are in authzRoleRejection.integration.test.ts.
 */
import { GET } from '../route';
import prisma from '@/lib/prisma';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockSession = require('next-auth/next').getServerSession;

const req = () => new Request('http://localhost/api/membership-ops/volunteer-memberships');

const lead = (name: string, email?: string) => ({ name, ...(email ? { email } : {}) });

/** A volunteer OrgMembership row as the route selects it. */
const membership = (over: Partial<Record<string, unknown>> = {}) => ({
    status: 'ACTIVE',
    memberSince: new Date('2025-03-04T00:00:00.000Z'),
    processes: [],
    household: { id: 1, name: 'Alvarez', householdMembers: [lead('Ana Alvarez', 'ana@example.com')] },
    ...over,
});

const designation = (id: number, email: string) => ({
    id,
    email,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
});

/** A household-lead Person row as the designation lookup selects it. */
const leadPerson = (email: string, over: Partial<Record<string, unknown>> = {}) => ({
    email,
    household: {
        id: 1,
        name: 'Alvarez',
        orgMembership: { status: 'ACTIVE', memberSince: new Date('2025-03-04T00:00:00.000Z'), processes: [] },
        householdMembers: [lead('Ana Alvarez')],
        ...over,
    },
});

function mockDb(opts: {
    memberships?: unknown[];
    designations?: unknown[];
    people?: unknown[];
}) {
    prisma.orgMembership.findMany = jest.fn().mockResolvedValue(opts.memberships ?? []);
    prisma.volunteerDesignation.findMany = jest.fn().mockResolvedValue(opts.designations ?? []);
    prisma.person.findMany = jest.fn().mockResolvedValue(opts.people ?? []);
}

const rowsFor = async () => (await (await GET(req())).json()).rows;

beforeEach(() => {
    jest.clearAllMocks();
    mockSession.mockResolvedValue({ user: { id: 5, isBoardMember: true } });
});

it('reports an ACTIVE volunteer household as a volunteer member', async () => {
    mockDb({ memberships: [membership()] });

    expect(await rowsFor()).toEqual([
        {
            key: 'hh:1',
            status: 'VOLUNTEER',
            householdId: 1,
            householdName: 'Alvarez',
            leads: ['Ana Alvarez'],
            email: 'ana@example.com',
            memberSince: '2025-03-04T00:00:00.000Z',
            designations: [],
        },
    ]);
});

it('reports a volunteer household with an in-flight process as in progress', async () => {
    mockDb({ memberships: [membership({ status: 'NONE', processes: [{ status: 'PENDING_PAYMENT' }] })] });

    const [row] = await rowsFor();
    expect(row.status).toBe('IN_PROGRESS');
    // memberSince is meaningless until the membership activates.
    expect(row.memberSince).toBeNull();
});

it('reports a volunteer household whose application is blocked as blocked, not pre-designated', async () => {
    mockDb({ memberships: [membership({ status: 'NONE', processes: [{ status: 'BLOCKED' }] })] });

    expect((await rowsFor())[0].status).toBe('BLOCKED');
});

it('reports a volunteer household with no live application as inactive', async () => {
    mockDb({ memberships: [membership({ status: 'NONE', processes: [] })] });

    expect((await rowsFor())[0].status).toBe('INACTIVE');
});

it('reports a revoked or denied volunteer household as revoked', async () => {
    mockDb({ memberships: [membership({ status: 'REVOKED' }), membership({ status: 'DENIED', household: { id: 2, name: 'Baker', householdMembers: [] } })] });

    expect((await rowsFor()).map((r: { status: string }) => r.status)).toEqual(['REVOKED', 'REVOKED']);
});

it('lists a designated email that has no person yet as pre-designated', async () => {
    mockDb({ designations: [designation(7, 'zoe@example.com')] });

    expect(await rowsFor()).toEqual([
        {
            key: 'des:7',
            status: 'DESIGNATED',
            householdId: null,
            householdName: null,
            leads: [],
            email: 'zoe@example.com',
            memberSince: null,
            designations: [{ id: 7, email: 'zoe@example.com', createdAt: '2026-07-01T00:00:00.000Z' }],
        },
    ]);
});

it('flags a designation on an already-active full-price household as taking effect next renewal', async () => {
    mockDb({
        designations: [designation(8, 'bo@example.com')],
        people: [leadPerson('bo@example.com', { id: 5, name: 'Baker', householdMembers: [lead('Bo Baker')] })],
    });

    const [row] = await rowsFor();
    expect(row).toMatchObject({ status: 'NEXT_RENEWAL', householdName: 'Baker', leads: ['Bo Baker'] });
});

it.each(['REVOKED', 'DENIED'])('reports a designation on a %s household as revoked, not pre-designated', async (status) => {
    // DENIED blocks login for the whole household, so "Pre-designated" would read
    // as queued-up-and-waiting for a family that cannot sign in at all.
    mockDb({
        designations: [designation(9, 'cy@example.com')],
        people: [leadPerson('cy@example.com', {
            orgMembership: { status, memberSince: new Date(), processes: [] },
        })],
    });

    expect((await rowsFor())[0].status).toBe('REVOKED');
});

it('carries a designated household through its live application status', async () => {
    mockDb({
        designations: [designation(9, 'cy@example.com')],
        people: [leadPerson('cy@example.com', {
            orgMembership: { status: 'NONE', memberSince: new Date(), processes: [{ status: 'PENDING_BG_REVIEW' }] },
        })],
    });

    expect((await rowsFor())[0].status).toBe('IN_PROGRESS');
});

it('folds a designation into the volunteer household it already produced', async () => {
    mockDb({
        memberships: [membership()],
        designations: [designation(7, 'ANA@example.com')],
        people: [leadPerson('ana@example.com')],
    });

    const rows = await rowsFor();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'hh:1', status: 'VOLUNTEER' });
    expect(rows[0].designations).toEqual([
        { id: 7, email: 'ANA@example.com', createdAt: '2026-07-01T00:00:00.000Z' },
    ]);
});

it('keeps every designation on a household that has more than one', async () => {
    mockDb({
        memberships: [membership()],
        designations: [designation(7, 'ana@example.com'), designation(8, 'alex@example.com')],
        people: [leadPerson('ana@example.com'), leadPerson('alex@example.com')],
    });

    const rows = await rowsFor();
    expect(rows).toHaveLength(1);
    // Both must survive: this row is the only place either can be removed.
    expect(rows[0].designations.map((d: { id: number }) => d.id)).toEqual([7, 8]);
});

it('matches a designation to its lead under the shared email canonicalization', async () => {
    // The membership-fee engine (applyVolunteerStatus) canonicalizes, so the roster must too
    // — otherwise this household would list twice and the Remove land on the wrong row.
    mockDb({
        memberships: [membership()],
        designations: [designation(7, 'A.na+vol@Gmail.com')],
        people: [leadPerson('anagmail@gmail.com', { id: 2, name: 'Baker' }), leadPerson('ana@gmail.com')],
    });

    const rows = await rowsFor();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'hh:1' });
    expect(rows[0].designations).toHaveLength(1);
});

it('does not resolve a designation through a non-lead person', async () => {
    // Only household leads can confer the volunteer fee, so the lookup filters to them;
    // an unmatched designation stands alone rather than implying a household.
    mockDb({ designations: [designation(7, 'kid@example.com')], people: [] });

    const [row] = await rowsFor();
    expect(row).toMatchObject({ key: 'des:7', householdId: null, status: 'DESIGNATED' });
    expect(prisma.person.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ isHouseholdLead: true }) }),
    );
});

it('skips the person lookup when there are no designations', async () => {
    mockDb({ memberships: [membership()] });
    await rowsFor();

    expect(prisma.person.findMany).not.toHaveBeenCalled();
});
