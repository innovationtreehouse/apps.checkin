/**
 * @jest-environment node
 */
/**
 * Concurrency test for renewal opening. runRenewalSweep (the board button) and
 * concurrent presses check-then-act through the shared
 * createRenewalProcess. Across instances
 * two overlapping runs each read zero open processes and both reach the INSERT —
 * which would mint duplicate PENDING_RENEWAL rows (and a dangling process
 * beginRenewalForUser never advances). We drive that losing branch directly: two
 * concurrent createRenewalProcess calls (the read-guard already passed). The
 * partial unique index `membership_one_inflight_renewal` is the guarantee — the
 * loser's INSERT hits P2002, which createRenewalProcess catches and turns into a
 * clean no-op (returns null, no second audit row). Drop the index and the second
 * INSERT succeeds → this fails.
 *
 * The machine never emails, so this test asserts no send; sendEmail is mocked only
 * as a blanket guard against any accidental real network call.
 */

import { createRenewalProcess } from '@/lib/membership/renewal';
import prisma from '@/lib/prisma';

const sendEmail = jest.fn().mockResolvedValue(true);
jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: (...a: unknown[]) => sendEmail(...a) }));

const TAG = 'renewal-concurrency-test';

async function wipe() {
    const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const ids = hhs.map((h) => h.id);
    if (ids.length) {
        await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: ids } } } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: ids } } });
    }
}

describe('renewal opening concurrency', () => {
    let orgMembershipId = 0;

    beforeAll(async () => {
        await wipe();
        const hh = await prisma.household.create({ data: { name: `Family ${TAG}` } });
        const lead = await prisma.person.create({ data: { name: 'Lead', email: `lead-${TAG}@ex.com`, householdId: hh.id } });
        await prisma.person.update({ where: { id: lead.id }, data: { isHouseholdLead: true } });
        orgMembershipId = (await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'ACTIVE' } })).id;
    });

    afterAll(wipe);

    it('two concurrent createRenewalProcess calls yield exactly one in-flight RENEWAL', async () => {
        const results = await Promise.all([
            createRenewalProcess(orgMembershipId),
            createRenewalProcess(orgMembershipId),
        ]);

        // Exactly one create won; the other lost the race and no-op'd (null).
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(results.filter((r) => r === null)).toHaveLength(1);

        const inflight = await prisma.orgMembershipProcess.findMany({
            where: { orgMembershipId, kind: 'RENEWAL', status: { in: ['PENDING_RENEWAL', 'RENEWAL_PENDING_BG', 'PENDING_PAYMENT'] } },
            select: { id: true },
        });
        expect(inflight).toHaveLength(1); // the loser's P2002 no-op'd, not a second process

        // The machine never emails — no reminder fires either way.
        expect(sendEmail).not.toHaveBeenCalled();

        // Exactly one CREATE audit row for the winning process — no orphan from the loser.
        const created = await prisma.auditLog.count({
            where: { tableName: 'OrgMembershipProcess', action: 'CREATE', affectedEntityId: inflight[0].id },
        });
        expect(created).toBe(1);
    });
});
