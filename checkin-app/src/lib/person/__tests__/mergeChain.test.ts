/**
 * @jest-environment node
 */
import prisma from "@/lib/prisma";
import { liveIdsOf, resolveMergedPerson, walkMergeChain } from "../mergeChain";

let rows: Set<number>;
let archive: Record<number, number>;

beforeEach(() => {
    rows = new Set();
    archive = {};
    prisma.person.findUnique = jest.fn(async ({ where }: { where: { id: number } }) =>
        rows.has(where.id) ? { id: where.id } : null,
    ) as jest.Mock;
    prisma.person.findMany = jest.fn(async ({ where }: { where: { id: { in: number[] } } }) =>
        where.id.in.filter((id) => rows.has(id)).map((id) => ({ id })),
    ) as jest.Mock;
    prisma.personMerge.findUnique = jest.fn(async ({ where }: { where: { fromId: number } }) =>
        where.fromId in archive ? { toId: archive[where.fromId] } : null,
    ) as jest.Mock;
});

const ids = (chain: { id: number }[]) => chain.map((s) => s.id);

describe("walkMergeChain", () => {
    it("resolves a live id to itself with a one-step chain", async () => {
        rows = new Set([1]);
        const { resolution, chain } = await walkMergeChain(1);
        expect(resolution).toMatchObject({ kind: "live", person: { id: 1 }, hops: 0 });
        expect(ids(chain)).toEqual([1]);
        expect(prisma.personMerge.findUnique).not.toHaveBeenCalled();
    });

    it("follows the archive to the survivor when the merged-away row is gone", async () => {
        rows = new Set([3]);
        archive = { 1: 3 };
        const { resolution, chain } = await walkMergeChain(1);
        expect(resolution).toMatchObject({ kind: "live", person: { id: 3 }, hops: 1 });
        expect(chain).toEqual([{ id: 1, person: null }, { id: 3, person: { id: 3 } }]);
    });

    it("is unknown when the id names no row and no archived merge", async () => {
        const { resolution, chain } = await walkMergeChain(1);
        expect(resolution).toEqual({ kind: "unknown" });
        expect(chain).toEqual([{ id: 1, person: null }]);
    });

    it("is broken when the archived survivor has no row", async () => {
        archive = { 1: 2 };
        const { resolution, chain } = await walkMergeChain(1);
        expect(resolution).toEqual({ kind: "broken", lastId: 2 });
        expect(ids(chain)).toEqual([1, 2]);
    });
});

describe("resolveMergedPerson", () => {
    it("returns the walk's resolution", async () => {
        rows = new Set([3]);
        archive = { 1: 3 };
        expect(await resolveMergedPerson(1)).toMatchObject({ kind: "live", person: { id: 3 } });
    });
});

describe("liveIdsOf", () => {
    it("maps a live id to itself, a merged-away id to its survivor and an unknown id to null", async () => {
        rows = new Set([1, 3]);
        archive = { 2: 3 };
        expect(await liveIdsOf([1, 2, 4])).toEqual(new Map([[1, 1], [2, 3], [4, null]]));
    });
});
