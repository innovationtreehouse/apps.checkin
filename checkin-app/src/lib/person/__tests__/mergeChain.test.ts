/**
 * @jest-environment node
 */
import prisma from "@/lib/prisma";
import { MAX_MERGE_HOPS, resolveMergedPerson, walkMergeChain } from "../mergeChain";

let rows: Record<number, { mergedIntoId: number | null }>;
let archive: Record<number, number>;

beforeEach(() => {
    rows = {};
    archive = {};
    prisma.person.findUnique = jest.fn(async ({ where }: { where: { id: number } }) =>
        where.id in rows ? { id: where.id, ...rows[where.id] } : null,
    ) as jest.Mock;
    prisma.personMerge.findUnique = jest.fn(async ({ where }: { where: { fromId: number } }) =>
        where.fromId in archive ? { toId: archive[where.fromId] } : null,
    ) as jest.Mock;
});

const ids = (chain: { id: number }[]) => chain.map((s) => s.id);

describe("walkMergeChain", () => {
    it("resolves a live id to itself with a one-step chain", async () => {
        rows = { 1: { mergedIntoId: null } };
        const { resolution, chain } = await walkMergeChain(1);
        expect(resolution).toMatchObject({ kind: "live", person: { id: 1 }, hops: 0 });
        expect(ids(chain)).toEqual([1]);
    });

    it("follows tombstones to the survivor and lists every record on the way", async () => {
        rows = { 1: { mergedIntoId: 2 }, 2: { mergedIntoId: 3 }, 3: { mergedIntoId: null } };
        const { resolution, chain } = await walkMergeChain(1);
        expect(resolution).toMatchObject({ kind: "live", person: { id: 3 }, first: { id: 1 }, hops: 2 });
        expect(ids(chain)).toEqual([1, 2, 3]);
    });

    it("follows an archive-only hop when the merged-away row is gone", async () => {
        rows = { 3: { mergedIntoId: null } };
        archive = { 1: 3 };
        const { resolution, chain } = await walkMergeChain(1);
        expect(resolution).toMatchObject({ kind: "live", person: { id: 3 }, first: null, hops: 1 });
        expect(chain).toEqual([{ id: 1, person: null }, { id: 3, person: { id: 3, mergedIntoId: null } }]);
    });

    it("is unknown when the id names no row and no archived merge", async () => {
        const { resolution, chain } = await walkMergeChain(1);
        expect(resolution).toEqual({ kind: "unknown" });
        expect(chain).toEqual([{ id: 1, person: null }]);
    });

    it("is broken at the gap when a merge pointer leads to nothing", async () => {
        rows = { 1: { mergedIntoId: 2 } };
        const { resolution, chain } = await walkMergeChain(1);
        expect(resolution).toEqual({ kind: "broken", lastId: 2 });
        expect(ids(chain)).toEqual([1, 2]);
    });

    it("stops at the hop cap without fetching the record it stopped at", async () => {
        for (let id = 1; id <= MAX_MERGE_HOPS + 3; id++) rows[id] = { mergedIntoId: id + 1 };
        const { resolution, chain } = await walkMergeChain(1);
        expect(resolution).toEqual({ kind: "broken", lastId: MAX_MERGE_HOPS + 2 });
        expect(ids(chain)).toEqual(Array.from({ length: MAX_MERGE_HOPS + 1 }, (_, i) => i + 1));
        expect(prisma.person.findUnique).toHaveBeenCalledTimes(MAX_MERGE_HOPS + 1);
    });

    it("stops a cycle at the hop cap", async () => {
        rows = { 1: { mergedIntoId: 2 }, 2: { mergedIntoId: 1 } };
        const { resolution, chain } = await walkMergeChain(1);
        expect(resolution.kind).toBe("broken");
        expect(chain).toHaveLength(MAX_MERGE_HOPS + 1);
    });
});

describe("resolveMergedPerson", () => {
    it("returns the walk's resolution", async () => {
        rows = { 3: { mergedIntoId: null } };
        archive = { 1: 3 };
        expect(await resolveMergedPerson(1)).toMatchObject({ kind: "live", person: { id: 3 } });
    });
});
