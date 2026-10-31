/**
 * @jest-environment node
 */
/**
 * Concurrency test for INITIAL intake opening. A double-click or two tabs can both
 * pass the "already in flight?" guard; unguarded, both INSERT and leave duplicate
 * INTAKE rows for one Membership.
 * startIntake runs the check+create inside a transaction holding a
 * `SELECT ... FOR UPDATE` lock on the parent Membership row, so the loser blocks
 * until the winner commits, then re-reads under the lock and returns the winner's
 * process instead of inserting a second one. We drive that directly: two
 * concurrent startIntake calls for the same household lead.
 *
 * The FOR UPDATE lock is the guarantee here (the loser returns the existing
 * process, never reaching the INSERT), so this holds whether or not the
 * push-provisioned test DB carries the partial unique index — same as
 * renewalConcurrency. TEST_DB_POOL_MAX=2 (jest.setup.js) puts the two calls on
 * separate connections so the row lock, not $transaction's own serialization, is
 * what's exercised.
 */

import { startIntake } from '@/lib/membership/intake';
import { IN_FLIGHT_INITIAL_STATUSES } from '@/lib/membership/phases';
import prisma from '@/lib/prisma';

const TAG = 'intake-concurrency-test';

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

describe('intake start concurrency', () => {
    let leadId = 0;
    let householdId = 0;

    beforeAll(async () => {
        await wipe();
        const hh = await prisma.household.create({ data: { name: `Family ${TAG}` } });
        householdId = hh.id;
        const lead = await prisma.person.create({ data: { name: 'Lead', email: `lead-${TAG}@ex.com`, householdId: hh.id } });
        leadId = lead.id;
        await prisma.person.update({ where: { id: lead.id }, data: { isHouseholdLead: true } });
    });

    afterAll(wipe);

    it('two concurrent startIntake calls yield exactly one in-flight INITIAL process', async () => {
        const results = await Promise.all([startIntake(leadId), startIntake(leadId)]);

        // Both return the SAME winning process — the loser re-checked under the lock.
        expect(results[0].id).toBe(results[1].id);

        const inflight = await prisma.orgMembershipProcess.findMany({
            where: { orgMembership: { householdId }, kind: 'INITIAL', status: { in: IN_FLIGHT_INITIAL_STATUSES } },
            select: { id: true },
        });
        expect(inflight).toHaveLength(1); // no duplicate from the loser

        // Exactly one CREATE audit row for the winner — no orphan from the loser.
        const created = await prisma.auditLog.count({
            where: { tableName: 'OrgMembershipProcess', action: 'CREATE', affectedEntityId: results[0].id },
        });
        expect(created).toBe(1);
    });
});
