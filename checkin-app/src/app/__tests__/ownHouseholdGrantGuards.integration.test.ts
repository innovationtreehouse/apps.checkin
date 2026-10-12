/**
 * @jest-environment node
 */
/**
 * No actor may grant their own household a volunteer discount or a
 * background-check date, under any role: the household volunteer flag, the
 * volunteer-designation allowlist, and the participant lastBackgroundCheck edit.
 * A board edit that makes a lead's check stale needs an explicit confirmation.
 */

import { PATCH as HOUSEHOLD_PATCH } from '@/app/api/membership-ops/households/[id]/route';
import { POST as DESIG_POST } from '@/app/api/settings/membership/volunteer-designations/route';
import { PUT as PARTICIPANT_PUT } from '@/app/api/membership-ops/participants/[id]/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';

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

    beforeAll(async () => {
        await wipe();
        const own = await prisma.household.create({
            data: { name: `Own ${TAG}`, orgMembership: { create: { status: 'ACTIVE', isVolunteer: false } } },
        });
        const other = await prisma.household.create({
            data: { name: `Other ${TAG}`, orgMembership: { create: { status: 'ACTIVE', isVolunteer: false } } },
        });
        ownHouseholdId = own.id;
        otherHouseholdId = other.id;
        actorId = (await prisma.person.create({ data: { email: `actor-${TAG}@gmail.com`, name: 'Actor', isBoardMember: true, isSysadmin: true, householdId: own.id } })).id;
        spouseId = (await prisma.person.create({ data: { email: `spouse-${TAG}@gmail.com`, name: 'Spouse', householdId: own.id } })).id;
        outsiderId = (await prisma.person.create({ data: { email: `outsider-${TAG}@example.com`, name: 'Outsider', householdId: other.id } })).id;
    });

    beforeEach(() => {
        // Both roles at once: no role bypasses the guard.
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: actorId, isSysadmin: true, isBoardMember: true } });
    });

    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    describe('household isVolunteer PATCH', () => {
        it('refuses flagging the actor’s own household', async () => {
            const res = await HOUSEHOLD_PATCH(jsonReq('PATCH', { isVolunteer: true }) as never, params(ownHouseholdId));
            expect(res.status).toBe(403);
            expect((await prisma.orgMembership.findUnique({ where: { householdId: ownHouseholdId } }))?.isVolunteer).toBe(false);
        });

        it('allows an own-household edit that resends the unchanged flag', async () => {
            const res = await HOUSEHOLD_PATCH(jsonReq('PATCH', { name: `Own ${TAG} renamed`, isVolunteer: false }) as never, params(ownHouseholdId));
            expect(res.status).toBe(200);
        });

        it('allows flagging another household', async () => {
            const res = await HOUSEHOLD_PATCH(jsonReq('PATCH', { isVolunteer: true }) as never, params(otherHouseholdId));
            expect(res.status).toBe(200);
            expect((await prisma.orgMembership.findUnique({ where: { householdId: otherHouseholdId } }))?.isVolunteer).toBe(true);
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
        });

        it('allows designating someone outside the actor’s household', async () => {
            const res = await DESIG_POST(jsonReq('POST', { email: `outsider-${TAG}@example.com` }));
            expect(res.status).toBe(201);
        });
    });

    describe('participant lastBackgroundCheck PUT', () => {
        it.each([
            ['the actor', () => actorId],
            ['a member of the actor’s household', () => spouseId],
        ])('refuses setting the date for %s', async (_label, target) => {
            const res = await PARTICIPANT_PUT(jsonReq('PUT', { lastBackgroundCheck: '2026-01-15' }) as never, params(target()));
            expect(res.status).toBe(403);
            expect((await prisma.person.findUnique({ where: { id: target() } }))?.lastBackgroundCheck).toBeNull();
        });

        it('allows an own-household edit that resends the unchanged date', async () => {
            const res = await PARTICIPANT_PUT(jsonReq('PUT', { phone: '', lastBackgroundCheck: '' }) as never, params(spouseId));
            expect(res.status).toBe(200);
        });

        it('sets the date for someone outside the household and audits old and new values', async () => {
            const first = await PARTICIPANT_PUT(jsonReq('PUT', { lastBackgroundCheck: '2026-01-15' }) as never, params(outsiderId));
            expect(first.status).toBe(200);
            const second = await PARTICIPANT_PUT(jsonReq('PUT', { lastBackgroundCheck: '2026-03-01' }) as never, params(outsiderId));
            expect(second.status).toBe(200);

            const log = await prisma.auditLog.findFirst({
                where: { actorId, tableName: 'Person', affectedEntityId: outsiderId },
                orderBy: { id: 'desc' },
            });
            expect((log?.oldData as { lastBackgroundCheck: string }).lastBackgroundCheck).toBe('2026-01-15T00:00:00.000Z');
            expect((log?.newData as { lastBackgroundCheck: string }).lastBackgroundCheck).toBe('2026-03-01T00:00:00.000Z');
        });
    });

    describe('stale lead check confirmation', () => {
        let restoreBoardSettings: () => Promise<void> = async () => {};
        let leadId: number;

        beforeAll(async () => {
            restoreBoardSettings = await snapshotBoardSettings();
            await prisma.boardSettings.upsert({
                where: { id: 1 },
                update: { orgMembershipYearBoundary: new Date('2026-08-01'), bgRecheckMonths: 24 },
                create: { id: 1, orgMembershipYearBoundary: new Date('2026-08-01'), bgRecheckMonths: 24 },
            });
            leadId = (await prisma.person.create({
                data: { email: `lead-${TAG}@example.com`, name: 'Lead', isHouseholdLead: true, householdId: otherHouseholdId, lastBackgroundCheck: new Date() },
            })).id;
        });

        afterAll(async () => {
            await restoreBoardSettings();
        });

        it('refuses clearing a fresh lead check without confirmation and leaves the date alone', async () => {
            const res = await PARTICIPANT_PUT(jsonReq('PUT', { lastBackgroundCheck: '' }) as never, params(leadId));
            expect(res.status).toBe(409);
            const data = await res.json();
            expect(data.requiresConfirmation).toBe(true);
            expect(data.warning).toMatch(/background check covers the membership year/);
            expect((await prisma.person.findUnique({ where: { id: leadId } }))?.lastBackgroundCheck).not.toBeNull();
        });

        it('saves after confirmation and records the warning in the audit row', async () => {
            const res = await PARTICIPANT_PUT(jsonReq('PUT', { lastBackgroundCheck: '2020-01-01', confirmBgStale: true }) as never, params(leadId));
            expect(res.status).toBe(200);
            const log = await prisma.auditLog.findFirst({
                where: { actorId, tableName: 'Person', affectedEntityId: leadId },
                orderBy: { id: 'desc' },
            });
            expect((log?.newData as { bgStaleWarning?: string }).bgStaleWarning).toMatch(/will not after this change/);
        });

        it('needs no confirmation for a non-lead', async () => {
            await prisma.person.update({ where: { id: outsiderId }, data: { lastBackgroundCheck: new Date() } });
            const res = await PARTICIPANT_PUT(jsonReq('PUT', { lastBackgroundCheck: '' }) as never, params(outsiderId));
            expect(res.status).toBe(200);
        });
    });
});
