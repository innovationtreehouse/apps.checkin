/**
 * @jest-environment node
 */
import type { DbClient } from '@/lib/db-client';
import { personActor } from '@/lib/auditActor';
import { setHouseholdStatus, type HouseholdStatus } from '@/lib/membership/householdStatus';

function client(status: HouseholdStatus) {
    return {
        orgMembership: {
            findUnique: jest.fn().mockResolvedValue({ status, householdId: 7 }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
}

/** A root client whose $transaction hands `fn` a separate tx, so writes on the root show up as outside it. */
function fakeDb(status: HouseholdStatus) {
    const tx = client(status);
    const root = {
        ...client(status),
        $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    return { tx, root, db: root as unknown as DbClient };
}

const actor = personActor(99);

describe('setHouseholdStatus', () => {
    it.each<[HouseholdStatus, HouseholdStatus]>([
        ['DENIED', 'ACTIVE'],
        ['ACTIVE', 'NONE'],
        ['REVOKED', 'NONE'],
    ])('throws on the undeclared edge %s → %s and touches nothing', async (from, to) => {
        const { root, tx, db } = fakeDb(from);
        await expect(setHouseholdStatus(db, 1, { from: [from], to, actor, reason: 'test' })).rejects.toThrow(
            `Household status ${from} → ${to} is not a declared transition`,
        );
        expect(root.$transaction).not.toHaveBeenCalled();
        expect(tx.orgMembership.updateMany).not.toHaveBeenCalled();
    });

    it('writes the status and its audit row inside one transaction', async () => {
        const { root, tx, db } = fakeDb('ACTIVE');
        await expect(setHouseholdStatus(db, 1, { from: ['ACTIVE'], to: 'REVOKED', actor, reason: 'test' })).resolves.toBe(true);
        expect(root.$transaction).toHaveBeenCalledTimes(1);
        expect(root.orgMembership.updateMany).not.toHaveBeenCalled();
        expect(root.auditLog.create).not.toHaveBeenCalled();
        expect(tx.orgMembership.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'REVOKED' } }));
        expect(tx.auditLog.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ oldData: { status: 'ACTIVE' }, newData: { status: 'REVOKED', reason: 'test' } }) }),
        );
    });
});
