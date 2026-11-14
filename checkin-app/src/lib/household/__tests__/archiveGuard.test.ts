/**
 * @jest-environment node
 *
 * lockLiveHouseholds refuses an archived household whether row security hides the
 * row or the connection sees it, and locks in household-id order.
 */

import type { DbClient } from "@/lib/db-client";
import { ArchivedHouseholdError, lockLiveHouseholds, lockLiveHouseholdsOf } from "@/lib/household/archiveGuard";
import { ServiceError } from "@checkin/component-kit";

/** A client whose Household rows are `rows` (missing id = hidden by row security). */
function client(rows: Record<number, { archivedAt: Date | null }>, people: { id: number; householdId: number }[][] = []) {
    const locked: number[] = [];
    const db = {
        $queryRaw: jest.fn(async (_sql: TemplateStringsArray, id: number) => {
            locked.push(id);
            return rows[id] ? [rows[id]] : [];
        }),
        person: { findMany: jest.fn() },
    };
    for (const read of people) db.person.findMany.mockResolvedValueOnce(read);
    return { db: db as unknown as DbClient, locked };
}

describe("lockLiveHouseholds", () => {
    it("passes live households, locking each once in id order", async () => {
        const { db, locked } = client({ 3: { archivedAt: null }, 9: { archivedAt: null } });
        await expect(lockLiveHouseholds(db, [9, 3, 9])).resolves.toBeUndefined();
        expect(locked).toEqual([3, 9]);
    });

    it("refuses a household row security hides", async () => {
        const { db } = client({});
        await expect(lockLiveHouseholds(db, [4])).rejects.toBeInstanceOf(ArchivedHouseholdError);
    });

    it("refuses an archived household a connection can see", async () => {
        const { db } = client({ 4: { archivedAt: new Date() } });
        const error = await lockLiveHouseholds(db, [4]).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ArchivedHouseholdError);
        expect(error).toMatchObject({ status: 409, message: expect.stringContaining("archived") });
    });
});

describe("lockLiveHouseholdsOf", () => {
    it("locks the households the people are in", async () => {
        const read = [{ id: 1, householdId: 5 }];
        const { db, locked } = client({ 5: { archivedAt: null } }, [read, read]);
        await lockLiveHouseholdsOf(db, [1]);
        expect(locked).toEqual([5]);
    });

    it("refuses a person in an archived household", async () => {
        const read = [{ id: 1, householdId: 5 }];
        const { db } = client({}, [read, read]);
        await expect(lockLiveHouseholdsOf(db, [1])).rejects.toBeInstanceOf(ArchivedHouseholdError);
    });

    it("refuses a person who moved household before the lock landed", async () => {
        const { db } = client({ 5: { archivedAt: null } }, [[{ id: 1, householdId: 5 }], [{ id: 1, householdId: 6 }]]);
        const error = await lockLiveHouseholdsOf(db, [1]).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ServiceError);
        expect(error).not.toBeInstanceOf(ArchivedHouseholdError);
        expect(error).toMatchObject({ status: 409 });
    });
});
