/**
 * @jest-environment node
 */
/**
 * The board and sysadmin participant routes keep the own-household rule and the
 * denied-household rule: an email change is the board's, with a reason, and never
 * for the actor's own household; nobody adds a person to, or promotes a lead in,
 * their own household or a DENIED one through the privileged path.
 */

import { PUT as PARTICIPANT_PUT } from '@/app/api/membership-ops/participants/[id]/route';
import { POST as PARTICIPANT_POST } from '@/app/api/membership-ops/participants/route';
import { POST as LEAD_POST } from '@/app/api/household/lead/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { SELF_GRANT_REFUSAL_TABLE } from '@/lib/membership/selfGrantGuard';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const TAG = 'admin-self-guard-test';

function jsonReq(method: string, body: unknown) {
    return new Request('http://localhost:4000/x', { method, body: JSON.stringify(body) }) as never;
}
const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const actAs = (id: number, roles: { isSysadmin?: boolean; isBoardMember?: boolean }) =>
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id, isSysadmin: false, isBoardMember: false, ...roles } });

describe('admin participant routes keep the own-household and denied rules', () => {
    let boardId: number, sysadminId: number, spouseId: number, outsiderId: number, deniedMemberId: number;
    let ownHouseholdId: number, otherHouseholdId: number, deniedHouseholdId: number;

    async function wipe() {
        const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const ids = hhs.map((h) => h.id);
        const people = await prisma.person.findMany({ where: { OR: [{ householdId: { in: ids } }, { email: { contains: TAG } }] }, select: { id: true, householdId: true } });
        const personIds = people.map((p) => p.id);
        const allHouseholdIds = [...new Set([...ids, ...people.map((p) => p.householdId)])];
        await prisma.paymentException.deleteMany({ where: { personId: { in: personIds } } });
        await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: personIds } }, { affectedEntityId: { in: personIds } }] } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: allHouseholdIds } } });
        await prisma.person.deleteMany({ where: { id: { in: personIds } } });
        await prisma.household.deleteMany({ where: { id: { in: allHouseholdIds } } });
    }

    async function lastRefusal(actorId: number) {
        const row = await prisma.auditLog.findFirst({ where: { actorId, tableName: SELF_GRANT_REFUSAL_TABLE }, orderBy: { id: 'desc' } });
        return row?.newData as { reason: string; table: string; attempted: Record<string, unknown> } | undefined;
    }

    beforeAll(async () => {
        await wipe();
        const own = await prisma.household.create({ data: { name: `Own ${TAG}`, orgMembership: { create: { status: 'ACTIVE' } } } });
        const other = await prisma.household.create({ data: { name: `Other ${TAG}`, orgMembership: { create: { status: 'ACTIVE' } } } });
        const denied = await prisma.household.create({ data: { name: `Denied ${TAG}`, orgMembership: { create: { status: 'DENIED' } } } });
        const sysadminHh = await prisma.household.create({ data: { name: `Sysadmin ${TAG}` } });
        ownHouseholdId = own.id;
        otherHouseholdId = other.id;
        deniedHouseholdId = denied.id;
        boardId = (await prisma.person.create({ data: { email: `board-${TAG}@example.com`, name: 'Board', isBoardMember: true, isSysadmin: true, householdId: own.id } })).id;
        spouseId = (await prisma.person.create({ data: { email: `spouse-${TAG}@example.com`, name: 'Spouse', isDeclaredAdult: true, householdId: own.id } })).id;
        outsiderId = (await prisma.person.create({ data: { email: `outsider-${TAG}@example.com`, name: 'Outsider', isDeclaredAdult: true, householdId: other.id } })).id;
        deniedMemberId = (await prisma.person.create({ data: { email: `denied-${TAG}@example.com`, name: 'Denied', isDeclaredAdult: true, householdId: denied.id } })).id;
        sysadminId = (await prisma.person.create({ data: { email: `sysadmin-${TAG}@example.com`, name: 'Sysadmin', isSysadmin: true, householdId: sysadminHh.id } })).id;
    });

    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    describe('participant email PUT', () => {
        it('refuses a sysadmin who is not on the board', async () => {
            actAs(sysadminId, { isSysadmin: true });
            const res = await PARTICIPANT_PUT(jsonReq('PUT', { email: `taken-${TAG}@example.com`, emailChangeReason: 'typo' }), params(outsiderId));
            expect(res.status).toBe(403);
            expect((await prisma.person.findUnique({ where: { id: outsiderId } }))?.email).toBe(`outsider-${TAG}@example.com`);
        });

        it('lets a sysadmin save other fields when the email is resent unchanged', async () => {
            actAs(sysadminId, { isSysadmin: true });
            const res = await PARTICIPANT_PUT(jsonReq('PUT', { name: 'Outsider', email: `OUTSIDER-${TAG}@example.com` }), params(outsiderId));
            expect(res.status).toBe(200);
        });

        it('refuses a board change with no reason', async () => {
            actAs(boardId, { isSysadmin: true, isBoardMember: true });
            const res = await PARTICIPANT_PUT(jsonReq('PUT', { email: `new-${TAG}@example.com`, emailChangeReason: '   ' }), params(outsiderId));
            expect(res.status).toBe(400);
            expect((await prisma.person.findUnique({ where: { id: outsiderId } }))?.email).toBe(`outsider-${TAG}@example.com`);
        });

        it('refuses a board member changing their own household’s email', async () => {
            actAs(boardId, { isSysadmin: true, isBoardMember: true });
            const res = await PARTICIPANT_PUT(jsonReq('PUT', { email: `redirect-${TAG}@example.com`, emailChangeReason: 'asked' }), params(spouseId));
            expect(res.status).toBe(403);
            expect((await prisma.person.findUnique({ where: { id: spouseId } }))?.email).toBe(`spouse-${TAG}@example.com`);
            expect(await lastRefusal(boardId)).toEqual(expect.objectContaining({ reason: 'own_household', table: 'Person', attempted: { email: `redirect-${TAG}@example.com` } }));
        });

        it('saves a board change for someone outside the household and audits the reason', async () => {
            actAs(boardId, { isSysadmin: true, isBoardMember: true });
            const res = await PARTICIPANT_PUT(jsonReq('PUT', { email: `moved-${TAG}@example.com`, emailChangeReason: ' New address, confirmed by phone ' }), params(outsiderId));
            expect(res.status).toBe(200);
            expect((await prisma.person.findUnique({ where: { id: outsiderId } }))?.email).toBe(`moved-${TAG}@example.com`);
            const audit = await prisma.auditLog.findFirst({ where: { actorId: boardId, tableName: 'Person', affectedEntityId: outsiderId, action: 'EDIT' }, orderBy: { id: 'desc' } });
            expect(audit?.newData).toEqual(expect.objectContaining({ email: `moved-${TAG}@example.com`, emailChangeReason: 'New address, confirmed by phone' }));
        });
    });

    describe('participant create POST', () => {
        beforeEach(() => actAs(boardId, { isSysadmin: true, isBoardMember: true }));

        it('refuses adding a person to the actor’s own household', async () => {
            const res = await PARTICIPANT_POST(jsonReq('POST', { name: `Added ${TAG}`, householdId: ownHouseholdId }));
            expect(res.status).toBe(403);
            expect(await prisma.person.count({ where: { name: `Added ${TAG}` } })).toBe(0);
            expect(await lastRefusal(boardId)).toEqual(expect.objectContaining({ reason: 'own_household', attempted: { householdId: ownHouseholdId, name: `Added ${TAG}` } }));
        });

        it('refuses adding a child under a parent in the actor’s own household', async () => {
            const res = await PARTICIPANT_POST(jsonReq('POST', { name: `Child ${TAG}`, parentEmail: `spouse-${TAG}@example.com` }));
            expect(res.status).toBe(403);
            expect(await prisma.person.count({ where: { name: `Child ${TAG}` } })).toBe(0);
        });

        it('refuses adding a person to a DENIED household and raises it to the board', async () => {
            const res = await PARTICIPANT_POST(jsonReq('POST', { name: `Denied add ${TAG}`, householdId: deniedHouseholdId }));
            expect(res.status).toBe(409);
            expect(await prisma.person.count({ where: { name: `Denied add ${TAG}` } })).toBe(0);
            expect(await prisma.paymentException.count({ where: { kind: 'DENIED_HOUSEHOLD_ACTIVITY', personId: deniedMemberId } })).toBe(1);
        });

        it('adds a person to another household', async () => {
            const res = await PARTICIPANT_POST(jsonReq('POST', { name: `Joined ${TAG}`, householdId: otherHouseholdId }));
            expect(res.status).toBe(200);
            expect((await prisma.person.findFirst({ where: { name: `Joined ${TAG}` } }))?.householdId).toBe(otherHouseholdId);
        });
    });

    describe('household lead POST', () => {
        it('refuses a board member making themself a lead', async () => {
            actAs(boardId, { isSysadmin: true, isBoardMember: true });
            const res = await LEAD_POST(jsonReq('POST', { participantId: boardId }));
            expect(res.status).toBe(403);
            expect((await prisma.person.findUnique({ where: { id: boardId } }))?.isHouseholdLead).toBe(false);
            expect(await lastRefusal(boardId)).toEqual(expect.objectContaining({ reason: 'own_household', attempted: { isHouseholdLead: true } }));
        });

        it('refuses promoting a lead in a DENIED household', async () => {
            actAs(sysadminId, { isSysadmin: true });
            const res = await LEAD_POST(jsonReq('POST', { participantId: deniedMemberId }));
            expect(res.status).toBe(409);
            expect((await prisma.person.findUnique({ where: { id: deniedMemberId } }))?.isHouseholdLead).toBe(false);
        });

        it('promotes a lead in another household', async () => {
            actAs(sysadminId, { isSysadmin: true });
            const res = await LEAD_POST(jsonReq('POST', { participantId: outsiderId }));
            expect(res.status).toBe(200);
            expect((await prisma.person.findUnique({ where: { id: outsiderId } }))?.isHouseholdLead).toBe(true);
        });

        it('lets a lead promote within their own household', async () => {
            await prisma.person.update({ where: { id: spouseId }, data: { isHouseholdLead: true } });
            actAs(spouseId, {});
            const res = await LEAD_POST(jsonReq('POST', { participantId: boardId }));
            expect(res.status).toBe(200);
            expect((await prisma.person.findUnique({ where: { id: boardId } }))?.isHouseholdLead).toBe(true);
        });
    });
});
