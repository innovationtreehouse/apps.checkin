import prisma from "@/lib/prisma";
import { runDevDataCheck, type DataCheckDb, type DevDataReport } from "@/lib/dev/dataCheck";

/**
 * Runs the dev data check's SQL against a real Postgres. It measures deltas around rows it adds, so
 * whatever other suites left in this worker's database does not change the result.
 */

const TAG = "dev-data-check-test";
const db: DataCheckDb = prisma;

function linked(report: DevDataReport, table: string, column: string): number {
    return report.linkedRows.find((r) => r.table === table && r.column === column)?.rows ?? 0;
}

describe("runDevDataCheck (integration)", () => {
    const originalEnv = process.env.CHECKIN_ENV;
    let householdId: number;
    let personIds: number[] = [];
    let eventId: number;

    beforeAll(() => {
        process.env.CHECKIN_ENV = "local";
    });

    afterAll(async () => {
        await prisma.rSVP.deleteMany({ where: { eventId } });
        await prisma.event.deleteMany({ where: { id: eventId } });
        await prisma.emergencyContact.deleteMany({ where: { householdId } });
        await prisma.person.deleteMany({ where: { id: { in: personIds } } });
        await prisma.household.deleteMany({ where: { id: householdId } });
        process.env.CHECKIN_ENV = originalEnv;
    });

    it("counts an unseeded household, its people and the rows that link to them", async () => {
        const before = await runDevDataCheck(db);

        const household = await prisma.household.create({ data: { name: `${TAG} household` } });
        householdId = household.id;
        const adult = await prisma.person.create({
            data: { name: `${TAG} adult`, email: `${TAG}@other.invalid`, householdId },
        });
        const child = await prisma.person.create({ data: { name: `${TAG} child`, householdId } });
        personIds = [adult.id, child.id];
        await prisma.emergencyContact.create({ data: { householdId, name: `${TAG} contact`, phone: "555-555-0100", phoneDigits: "5555550100" } });
        const event = await prisma.event.create({
            data: { name: `${TAG} event`, startAt: new Date(), endAt: new Date(Date.now() + 3_600_000) },
        });
        eventId = event.id;
        await prisma.rSVP.create({ data: { eventId, personId: adult.id, status: "ATTENDING" } });

        const after = await runDevDataCheck(db);

        expect(after.people.notSeeded - before.people.notSeeded).toBe(2);
        expect(after.households.notSeeded - before.households.notSeeded).toBe(1);
        expect(linked(after, "EmergencyContact", "householdId") - linked(before, "EmergencyContact", "householdId")).toBe(1);
        expect(linked(after, "RSVP", "personId") - linked(before, "RSVP", "personId")).toBe(1);
        expect((after.linkedRecords.Event ?? 0) - (before.linkedRecords.Event ?? 0)).toBe(1);
        expect(JSON.stringify(after)).not.toContain(TAG);
    });
});
