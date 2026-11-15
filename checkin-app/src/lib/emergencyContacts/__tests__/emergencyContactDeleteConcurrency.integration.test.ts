/**
 * @jest-environment node
 */
/**
 * deleteContact against real Postgres: two leads deleting a household's last
 * two valid contacts at once leave one behind. The first delete holds its
 * transaction open after deleting; the second starts only then, and the test
 * waits until Postgres reports it blocked on the Household lock before letting
 * the first commit. (The file name opts into a two-connection pool, so the two
 * deletes run on separate connections.)
 */
import { Client } from "pg";
import prisma from "@/lib/prisma";
import { createContact, deleteContact, EmergencyContactError } from "@/lib/emergencyContacts/service";

const TAG = "ec-delete-race-test";
const monitor = new Client({ connectionString: process.env.DATABASE_URL });

async function wipe() {
    const hhIds = (await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } })).map((h) => h.id);
    await prisma.emergencyContact.deleteMany({ where: { householdId: { in: hhIds } } });
    await prisma.household.deleteMany({ where: { id: { in: hhIds } } });
}

async function blockedOnHouseholdLock(): Promise<boolean> {
    const { rows } = await monitor.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND query LIKE '%"Household"%FOR UPDATE%'`,
    );
    return rows[0].n > 0;
}

beforeAll(async () => {
    await monitor.connect();
    await wipe();
});
afterAll(async () => {
    await wipe();
    await monitor.end();
    await prisma.$disconnect();
});

it("two concurrent deletes of the last two valid contacts: exactly one succeeds", async () => {
    const hh = (await prisma.household.create({ data: { name: TAG } })).id;
    const a = await createContact(prisma, hh, { name: "Aunt May", phone: "555-555-2000" });
    const b = await createContact(prisma, hh, { name: "Uncle Ben", phone: "555-555-3000" });

    let deletedA!: () => void;
    const aDeleted = new Promise<void>((r) => (deletedA = r));
    let commitA!: () => void;
    const aMayCommit = new Promise<void>((r) => (commitA = r));

    const first = prisma.$transaction(async (tx) => {
        await deleteContact(tx, hh, a.id);
        deletedA();
        await aMayCommit;
    });
    await aDeleted;

    let secondSettled = false;
    const second = deleteContact(prisma, hh, b.id).finally(() => (secondSettled = true));
    while (!secondSettled && !(await blockedOnHouseholdLock()));
    commitA();

    const [r1, r2] = await Promise.allSettled([first, second]);
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("rejected");
    const reason = (r2 as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(EmergencyContactError);
    expect((reason as EmergencyContactError).code).toBe("last_valid");

    const left = await prisma.emergencyContact.findMany({ where: { householdId: hh } });
    expect(left.map((c) => c.id)).toEqual([b.id]);
});
