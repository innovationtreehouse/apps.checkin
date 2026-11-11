/**
 * @jest-environment node
 */
import type { DbClient } from '@/lib/db-client';
import { personActor } from '@/lib/auditActor';
import { setHouseholdStatus, type HouseholdStatus } from '@/lib/membership/householdStatus';
import { applyHouseholdDenial } from '@/lib/membership/denial';

jest.mock('@/lib/membership/denial', () => ({
    applyHouseholdDenial: jest.fn().mockResolvedValue({ revokedReviewIds: [], boardItemIds: [] }),
}));
const applyDenial = applyHouseholdDenial as jest.MockedFunction<typeof applyHouseholdDenial>;

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

    it.each<HouseholdStatus>(['NONE', 'ACTIVE', 'REVOKED'])('applies the denial inside the same transaction, from %s', async (from) => {
        applyDenial.mockClear();
        const { tx, db } = fakeDb(from);
        await expect(setHouseholdStatus(db, 1, { from: [from], to: 'DENIED', actor, reason: 'test' })).resolves.toBe(true);
        expect(applyDenial).toHaveBeenCalledTimes(1);
        expect(applyDenial).toHaveBeenCalledWith(tx, 7, actor);
    });

    it.each<[HouseholdStatus, HouseholdStatus]>([
        ['ACTIVE', 'REVOKED'],
        ['NONE', 'ACTIVE'],
        ['DENIED', 'NONE'],
    ])('applies no denial on %s → %s', async (from, to) => {
        applyDenial.mockClear();
        const { db } = fakeDb(from);
        await expect(setHouseholdStatus(db, 1, { from: [from], to, actor, reason: 'test' })).resolves.toBe(true);
        expect(applyDenial).not.toHaveBeenCalled();
    });

    it('applies no denial when the compare-and-set misses', async () => {
        applyDenial.mockClear();
        const { tx, db } = fakeDb('ACTIVE');
        tx.orgMembership.updateMany.mockResolvedValue({ count: 0 });
        await expect(setHouseholdStatus(db, 1, { from: ['ACTIVE'], to: 'DENIED', actor, reason: 'test' })).resolves.toBe(false);
        expect(applyDenial).not.toHaveBeenCalled();
    });
});
