import { deleteContact, EmergencyContactError } from "@/lib/emergencyContacts/service";
import type { DbClient } from "@/lib/db-client";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";

jest.mock("@/lib/getFullAttendance", () => ({ invalidateAttendanceCache: jest.fn() }));

type Row = { id: number; name: string; phone: string; conflictParticipantId: number | null };

function fakeDb(rows: Row[]) {
    const calls: string[] = [];
    const tx = {
        $queryRaw: jest.fn(async () => {
            calls.push("lock");
            return [{ archivedAt: null }];
        }),
        emergencyContact: {
            findMany: jest.fn(async () => {
                calls.push("read");
                return rows;
            }),
            delete: jest.fn(async () => {
                calls.push("delete");
            }),
        },
    };
    const db = { $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) };
    return { db: db as unknown as DbClient, tx, calls };
}

const valid = (id: number): Row => ({ id, name: `C${id}`, phone: "555-555-2000", conflictParticipantId: null });

describe("deleteContact guard", () => {
    beforeEach(() => jest.mocked(invalidateAttendanceCache).mockClear());

    it("locks the household, then reads, then deletes, in one transaction", async () => {
        const { db, tx, calls } = fakeDb([valid(1), valid(2)]);
        await deleteContact(db, 7, 1);
        expect(calls).toEqual(["lock", "read", "delete"]);
        expect(tx.emergencyContact.delete).toHaveBeenCalledWith({ where: { id: 1 } });
        expect(invalidateAttendanceCache).toHaveBeenCalledTimes(1);
    });

    it("refuses to delete the last valid contact", async () => {
        const { db, tx } = fakeDb([valid(1), { ...valid(2), conflictParticipantId: 9 }, { ...valid(3), phone: "" }]);
        await expect(deleteContact(db, 7, 1)).rejects.toMatchObject({ code: "last_valid" });
        expect(tx.emergencyContact.delete).not.toHaveBeenCalled();
        expect(invalidateAttendanceCache).not.toHaveBeenCalled();
    });

    it("deletes an invalid contact even when it leaves no valid one", async () => {
        const { db, tx } = fakeDb([{ ...valid(1), name: "" }]);
        await deleteContact(db, 7, 1);
        expect(tx.emergencyContact.delete).toHaveBeenCalled();
        expect(invalidateAttendanceCache).toHaveBeenCalledTimes(1);
    });

    it("throws not_found for a contact outside the household", async () => {
        const { db } = fakeDb([valid(1)]);
        const err = await deleteContact(db, 7, 99).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(EmergencyContactError);
        expect((err as EmergencyContactError).code).toBe("not_found");
    });
});
