/** @jest-environment node */
import prisma from "@/lib/prisma";
import { executeMerge, prepareMerge } from "@/lib/person/merge/execute";

jest.mock("@/lib/email", () => ({ runPaced: async (t: Array<() => Promise<unknown>>) => { for (const f of t) await f(); }, sendEmail: jest.fn().mockResolvedValue(true) }));

const TAG = `ml${Date.now()}`;
const CHOICES = { name: "keep", identity: "keep" };

describe("person merge and list-sync rows", () => {
    let keep: number, gone: number, actor: number, houseId: number, actorHouseId: number;
    const ref = `l-${TAG}@lists.example.org`;
    const mk = (personId: number, data: object, targetRef = ref) =>
        prisma.listSyncState.create({ data: { personId, targetKind: "NEWSLETTER", targetRef, ...data } });

    beforeEach(async () => {
        houseId = (await prisma.household.create({ data: { name: `${TAG} h` } })).id;
        actorHouseId = (await prisma.household.create({ data: { name: `${TAG} a` } })).id;
        const p = (name: string, householdId: number) => prisma.person.create({ data: { name: `${TAG} ${name}`, email: `${name}-${TAG}@example.com`, householdId } });
        keep = (await p("keep", houseId)).id;
        gone = (await p("gone", houseId)).id;
        actor = (await p("actor", actorHouseId)).id;
    });

    afterEach(async () => {
        const ids = [keep, gone, actor];
        await prisma.listSyncState.deleteMany({ where: { OR: [{ personId: { in: ids } }, { lastIntentActorId: { in: ids } }] } });
        await prisma.programExternalContact.deleteMany({ where: { createdById: { in: ids } } });
        await prisma.personMerge.deleteMany({ where: { OR: [{ toId: { in: ids } }, { fromId: { in: ids } }] } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
        await prisma.person.deleteMany({ where: { id: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: [houseId, actorHouseId] } } });
    });

    it("refuses when one side is OUT and the other applied, naming the list", async () => {
        await mk(keep, { appliedEmail: "k@example.com", appliedAt: new Date() });
        await mk(gone, { lastIntent: "OUT", lastIntentAt: new Date(), lastIntentSource: "APP" });
        const r = await prepareMerge(null, keep, gone, CHOICES);
        expect(r).toMatchObject({ refused: { status: 409 } });
        expect("refused" in r && r.refused.error).toContain(ref);
        expect(await prisma.person.count({ where: { id: gone } })).toBe(1);
    });

    it("moves rows, collapses matching ones to the keeper's, and repoints the actor and contact author", async () => {
        const other = `o-${TAG}@lists.example.org`;
        const keeperRow = await mk(keep, { lastIntent: "IN", lastIntentAt: new Date(), lastIntentSource: "APP" });
        await mk(gone, { lastIntent: "IN", lastIntentAt: new Date(), lastIntentSource: "APP" });
        await mk(gone, { lastIntent: "OUT", lastIntentAt: new Date(), lastIntentSource: "BOARD", lastIntentActorId: gone }, other);
        const program = await prisma.program.create({ data: { name: `${TAG} p`, startAt: new Date(), endAt: new Date(), appliesToYear: 2026 } });
        await prisma.programExternalContact.create({ data: { programId: program.id, email: `x-${TAG}@example.org`, createdById: gone } });

        const r = await prepareMerge(null, keep, gone, CHOICES);
        if (!("plan" in r)) throw new Error(JSON.stringify(r));
        await executeMerge(r.plan, null);

        const rows = await prisma.listSyncState.findMany({ where: { personId: keep }, orderBy: { id: "asc" } });
        expect(rows.map((x) => x.targetRef).sort()).toEqual([other, ref].sort());
        expect(rows.find((x) => x.targetRef === ref)?.id).toBe(keeperRow.id);
        expect(rows.find((x) => x.targetRef === other)?.lastIntentActorId).toBe(keep);
        expect((await prisma.programExternalContact.findFirstOrThrow({ where: { programId: program.id } })).createdById).toBe(keep);
        await prisma.programExternalContact.deleteMany({ where: { programId: program.id } });
        await prisma.program.delete({ where: { id: program.id } });
    });
});
