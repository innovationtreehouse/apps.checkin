/**
 * @jest-environment node
 */
/**
 * No actor may grant their own household a volunteer discount or a
 * background-check date, under any role: the household volunteer flag, the
 * volunteer-designation allowlist. The participant edit writes no
 * background-check date at all.
 */

import { PATCH as HOUSEHOLD_PATCH } from '@/app/api/membership-ops/households/[id]/route';
import { POST as DESIG_POST } from '@/app/api/settings/membership/volunteer-designations/route';
import { PUT as PARTICIPANT_PUT } from '@/app/api/membership-ops/participants/[id]/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { SELF_GRANT_REFUSAL_TABLE } from '@/lib/membership/selfGrantGuard';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const TAG = 'own-hh-grant-test';

function jsonReq(method: string, body: unknown) {
    return new Request('http://localhost:4000/x', { method, body: JSON.stringify(body) }) as never;
}
const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

describe('own-household grant guards', () => {
    let actorId: number, spouseId: number, outsiderId: number;
    let ownHouseholdId: number, otherHouseholdId: number;

    async function wipe() {
        await prisma.volunteerDesignation.deleteMany({ where: { email: { contains: TAG } } });
        const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const ids = hhs.map((h) => h.id);
        const people = await prisma.person.findMany({ where: { householdId: { in: ids } }, select: { id: true } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: people.map((p) => p.id) } } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: ids } } });
    }

    /** The newest refusal row the shared guard wrote for this actor. */
    async function lastRefusal() {
        const row = await prisma.auditLog.findFirst({ where: { actorId, tableName: SELF_GRANT_REFUSAL_TABLE }, orderBy: { id: 'desc' } });
        return row?.newData as { reason: string; table: string; attempted: Record<string, unknown> } | undefined;
    }

    beforeAll(async () => {
        await wipe();
        const own = await prisma.household.create({
            data: { name: `Own ${TAG}`, orgMembership: { create: { status: 'ACTIVE', isVolunteerFamily: false } } },
        });
        const other = await prisma.household.create({
            data: { name: `Other ${TAG}`, orgMembership: { create: { status: 'ACTIVE', isVolunteerFamily: false } } },
        });
        ownHouseholdId = own.id;
        otherHouseholdId = other.id;
        actorId = (await prisma.person.create({ data: { email: `actor-${TAG}@gmail.com`, name: 'Actor', isBoardMember: true, isSysadmin: true, householdId: own.id } })).id;
        spouseId = (await prisma.person.create({ data: { email: `spouse-${TAG}@gmail.com`, name: 'Spouse', householdId: own.id } })).id;
        outsiderId = (await prisma.person.create({ data: { email: `outsider-${TAG}@example.com`, name: 'Outsider', householdId: other.id } })).id;
        await prisma.account.create({ data: { userId: outsiderId, type: 'oauth', provider: 'google', providerAccountId: `${TAG}-${outsiderId}` } });
    });

    beforeEach(() => {
        // Both roles at once: no role bypasses the guard.
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: actorId, isSysadmin: true, isBoardMember: true } });
    });

    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    describe('household isVolunteerFamily PATCH', () => {
        it('refuses flagging the actor’s own household', async () => {
            const res = await HOUSEHOLD_PATCH(jsonReq('PATCH', { isVolunteerFamily: true }) as never, params(ownHouseholdId));
            expect(res.status).toBe(403);
            expect((await prisma.orgMembership.findUnique({ where: { householdId: ownHouseholdId } }))?.isVolunteerFamily).toBe(false);
            expect(await lastRefusal()).toEqual({ reason: 'own_household', table: 'OrgMembership', subject: { householdId: ownHouseholdId }, attempted: { isVolunteerFamily: true } });
        });

        it('allows an own-household edit that resends the unchanged flag', async () => {
            const res = await HOUSEHOLD_PATCH(jsonReq('PATCH', { name: `Own ${TAG} renamed`, isVolunteerFamily: false }) as never, params(ownHouseholdId));
            expect(res.status).toBe(200);
        });

        it('allows flagging another household', async () => {
            const res = await HOUSEHOLD_PATCH(jsonReq('PATCH', { isVolunteerFamily: true }) as never, params(otherHouseholdId));
            expect(res.status).toBe(200);
            expect((await prisma.orgMembership.findUnique({ where: { householdId: otherHouseholdId } }))?.isVolunteerFamily).toBe(true);
        });

        it('accepts the pre-rename isVolunteer key from a stale client', async () => {
            const res = await HOUSEHOLD_PATCH(jsonReq('PATCH', { isVolunteer: false }) as never, params(otherHouseholdId));
            expect(res.status).toBe(200);
            expect((await prisma.orgMembership.findUnique({ where: { householdId: otherHouseholdId } }))?.isVolunteerFamily).toBe(false);
        });
    });

    describe('volunteer designation POST', () => {
        it.each([
            ['the actor’s own email', `actor-${TAG}@gmail.com`],
            ['an inbox variant of a household member’s email', `Spouse-${TAG}+vol@gmail.com`],
        ])('refuses %s', async (_label, email) => {
            const res = await DESIG_POST(jsonReq('POST', { email }));
            expect(res.status).toBe(403);
            expect(await prisma.volunteerDesignation.count({ where: { email: { contains: TAG } } })).toBe(0);
            expect(await lastRefusal()).toEqual(expect.objectContaining({ reason: 'own_household', table: 'VolunteerDesignation' }));
        });

        it('allows designating an address outside the actor’s household', async () => {
            const res = await DESIG_POST(jsonReq('POST', { email: `newcomer-${TAG}@example.com` }));
            expect(res.status).toBe(201);
            const { designation } = await res.json();
            const log = await prisma.auditLog.findFirst({ where: { actorId, action: 'CREATE', tableName: 'VolunteerDesignation', affectedEntityId: designation.id } });
            expect(log?.newData).toEqual({ email: `newcomer-${TAG}@example.com` });
        });

        it('shows, rather than stores, a person outside the actor’s household', async () => {
            const res = await DESIG_POST(jsonReq('POST', { email: `outsider-${TAG}@example.com` }));
            expect(res.status).toBe(200);
            expect(await res.json()).toMatchObject({ requiresConfirmation: true, match: { householdId: otherHouseholdId } });
        });

        it('refuses an actor whose household cannot be resolved (fail closed)', async () => {
            const gone = await prisma.person.create({ data: { email: `gone-${TAG}@example.com`, name: 'Gone', householdId: otherHouseholdId } });
            await prisma.person.delete({ where: { id: gone.id } });
            (getServerSession as jest.Mock).mockResolvedValue({ user: { id: gone.id, isSysadmin: false, isBoardMember: true } });
            const res = await DESIG_POST(jsonReq('POST', { email: `stranger-${TAG}@example.com` }));
            expect(res.status).toBe(403);
            const row = await prisma.auditLog.findFirst({ where: { actorId: gone.id, tableName: SELF_GRANT_REFUSAL_TABLE } });
            expect((row?.newData as { reason: string }).reason).toBe('actor_household_unresolved');
            await prisma.auditLog.deleteMany({ where: { actorId: gone.id } });
        });
    });

    // Board ruling B5/B25, 2026-10-27: a background-check date comes only from a clearance.
    describe('participant PUT never writes the background-check date', () => {
        const DATE = new Date('2026-03-01T00:00:00.000Z');
        beforeAll(async () => {
            await prisma.person.update({ where: { id: outsiderId }, data: { lastBackgroundCheck: DATE } });
        });
        const dateOf = async (id: number) => (await prisma.person.findUnique({ where: { id } }))?.lastBackgroundCheck ?? null;

        it('treats a date-only body as nothing to update', async () => {
            const res = await PARTICIPANT_PUT(jsonReq('PUT', { lastBackgroundCheck: '2026-06-01', bgCheckReason: 'Vendor report seen' }) as never, params(outsiderId));
            expect(res.status).toBe(400);
            expect(await dateOf(outsiderId)).toEqual(DATE);
        });

        it.each([
            ['moved later', '2026-06-01'],
            ['moved earlier', '2026-01-01'],
            ['removed', null],
            ['removed with a blank', ''],
        ])('leaves the date alone when the body asks for it to be %s', async (_label, value) => {
            const res = await PARTICIPANT_PUT(jsonReq('PUT', { phone: '', lastBackgroundCheck: value, confirmBgStale: true }) as never, params(outsiderId));
            expect(res.status).toBe(200);
            expect(await dateOf(outsiderId)).toEqual(DATE);
        });

        it('does not set a date for the actor’s own household either', async () => {
            const res = await PARTICIPANT_PUT(jsonReq('PUT', { phone: '', lastBackgroundCheck: '2026-01-15' }) as never, params(spouseId));
            expect(res.status).toBe(200);
            expect(await dateOf(spouseId)).toBeNull();
        });
    });
});
