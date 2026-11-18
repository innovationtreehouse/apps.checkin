/**
 * @jest-environment node
 */
/**
 * A lead says the household won't renew, then confirms the renewal anyway: the
 * note is set with its audit row, and confirming clears it in the same step.
 */
import prisma from '@/lib/prisma';
import { clearNotRenewing, markNotRenewing, notRenewingTargetYear } from '@/lib/membership/notRenewing';
import { beginRenewal } from '@/lib/membership/renewal';
import { setMembershipYearBoundary } from '@/test-helpers/boardSettings';

jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));
jest.mock('@/lib/emailRecipients', () => ({ emailBoardMembers: jest.fn().mockResolvedValue(1) }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { emailBoardMembers } = require('@/lib/emailRecipients');

const TAG = 'not-renewing-test';
let restoreSettings: () => Promise<void> = async () => {};

async function renewingFamily() {
    const household = await prisma.household.create({ data: { name: `${TAG} household` } });
    const lead = await prisma.person.create({
        data: { name: 'Lead', email: `lead-${TAG}-${household.id}@example.com`, householdId: household.id, isHouseholdLead: true, dateOfBirth: new Date('1980-01-01T00:00:00Z') },
    });
    const membership = await prisma.orgMembership.create({ data: { householdId: household.id, status: 'ACTIVE' } });
    const renewal = await prisma.orgMembershipProcess.create({ data: { orgMembershipId: membership.id, kind: 'RENEWAL', status: 'PENDING_RENEWAL' } });
    return { leadId: lead.id, orgMembershipId: membership.id, renewalId: renewal.id };
}

const noteOf = async (id: number) => (await prisma.orgMembership.findUniqueOrThrow({ where: { id } })).notRenewingYear;
const auditRows = (id: number) => prisma.auditLog.findMany({ where: { tableName: 'OrgMembership', affectedEntityId: id }, orderBy: { id: 'asc' } });

async function wipe() {
    const households = await prisma.household.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    const ids = households.map((h) => h.id);
    const memberships = await prisma.orgMembership.findMany({ where: { householdId: { in: ids } }, select: { id: true } });
    const processes = await prisma.orgMembershipProcess.findMany({ where: { orgMembershipId: { in: memberships.map((m) => m.id) } }, select: { id: true } });
    await prisma.auditLog.deleteMany({
        where: { OR: [
            { tableName: 'OrgMembership', affectedEntityId: { in: memberships.map((m) => m.id) } },
            { tableName: 'OrgMembershipProcess', affectedEntityId: { in: processes.map((p) => p.id) } },
        ] },
    });
    await prisma.orgMembershipProcess.deleteMany({ where: { id: { in: processes.map((p) => p.id) } } });
    await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
    await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
    await prisma.household.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
    restoreSettings = await setMembershipYearBoundary();
    await wipe();
});

afterAll(async () => {
    await wipe();
    await restoreSettings();
    await prisma.$disconnect();
});

describe('not renewing', () => {
    it('marks the noted year once, emails the Board once, and is cleared by undo', async () => {
        const f = await renewingFamily();
        const year = notRenewingTargetYear(new Date('2000-09-01T00:00:00Z'), new Date());

        await markNotRenewing(f.leadId);
        await markNotRenewing(f.leadId);
        expect(await noteOf(f.orgMembershipId)).toBe(year);
        expect(emailBoardMembers).toHaveBeenCalledTimes(1);

        await clearNotRenewing(f.leadId);
        expect(await noteOf(f.orgMembershipId)).toBeNull();
        expect((await auditRows(f.orgMembershipId)).map((r) => r.newData)).toEqual([{ notRenewingYear: year }, { notRenewingYear: null }]);
    });

    it('confirming the renewal clears the note in the same step', async () => {
        const f = await renewingFamily();
        await markNotRenewing(f.leadId);

        await beginRenewal(f.renewalId, f.leadId);

        expect(await noteOf(f.orgMembershipId)).toBeNull();
        expect((await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: f.renewalId } })).status).not.toBe('PENDING_RENEWAL');
        expect((await auditRows(f.orgMembershipId)).at(-1)?.actorId).toBe(f.leadId);
    });
});
