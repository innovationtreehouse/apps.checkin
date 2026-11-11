import type { DbClient } from "@/lib/db-client";
import { anyMergedAway, archivedPeople, personNamesById } from "../archivedPeople";

function fakeDb(people: { id: number; name: string | null }[], archive: { fromId: number; toId: number; snapshot: unknown }[]) {
    const db = {
        person: { findMany: jest.fn(async () => people) },
        personMerge: {
            findMany: jest.fn(async ({ where }: { where: { fromId: { in: number[] } } }) => archive.filter((a) => where.fromId.in.includes(a.fromId))),
            count: jest.fn(async ({ where }: { where: { fromId: { in: number[] } } }) => archive.filter((a) => where.fromId.in.includes(a.fromId)).length),
        },
    };
    return { db, client: db as unknown as DbClient };
}

describe("archivedPeople", () => {
    it("reads name and survivor from the snapshot, and skips ids with no archive row", async () => {
        const { client } = fakeDb([], [{ fromId: 7, toId: 3, snapshot: { name: "Jane", email: "j@example.com" } }]);
        expect(await archivedPeople(client, [7, 8])).toEqual([{ id: 7, name: "Jane", mergedIntoId: 3 }]);
    });

    it("reads a malformed snapshot as no name", async () => {
        const { client } = fakeDb([], [{ fromId: 7, toId: 3, snapshot: ["not", "an", "object"] }, { fromId: 9, toId: 3, snapshot: { name: 42 } }]);
        expect(await archivedPeople(client, [7, 9])).toEqual([
            { id: 7, name: null, mergedIntoId: 3 },
            { id: 9, name: null, mergedIntoId: 3 },
        ]);
    });

    it("queries nothing for no ids", async () => {
        const { db, client } = fakeDb([], []);
        expect(await archivedPeople(client, [])).toEqual([]);
        expect(db.personMerge.findMany).not.toHaveBeenCalled();
    });
});

describe("personNamesById", () => {
    it("takes a live row's name, and the archive's only for an id with no row", async () => {
        const { db, client } = fakeDb(
            [{ id: 1, name: "Live" }],
            [{ fromId: 1, toId: 5, snapshot: { name: "Stale" } }, { fromId: 2, toId: 5, snapshot: { name: "Merged" } }],
        );
        const names = await personNamesById(client, [1, 2, 4]);
        expect([...names]).toEqual([[1, "Live"], [2, "Merged"]]);
        expect(db.personMerge.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { fromId: { in: [2, 4] } } }));
    });
});

describe("anyMergedAway", () => {
    it("is true only when an id has an archive row", async () => {
        const { client } = fakeDb([], [{ fromId: 2, toId: 5, snapshot: {} }]);
        expect(await anyMergedAway(client, [1, 2])).toBe(true);
        expect(await anyMergedAway(client, [1, 3])).toBe(false);
    });
});
