/**
 * @jest-environment node
 */
/**
 * An actor who joins a household while a participant add or a lead promotion into it
 * waits on that household's lock is refused under the lock, with an audit row. A holder
 * transaction on an outside connection holds the Household row and moves the actor in,
 * uncommitted, so the route's first check passes and only its locked re-check can refuse.
 */
import { POST as addParticipant } from '@/app/api/membership-ops/participants/route';
import { POST as promoteLead } from '@/app/api/household/lead/route';
import { SELF_GRANT_REFUSAL_TABLE } from '@/lib/membership/selfGrantGuard';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { Client } from 'pg';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const TAG = 'self-grant-recheck-test';
let seq = 0;

/** Waits until `count` other backends of this database are waiting on a row lock. */
async function waitForBlocked(holder: Client, count: number) {
    for (let i = 0; i < 200; i++) {
        // Postgres caches pg_stat_activity for the transaction unless the snapshot is cleared.
        await holder.query('SELECT pg_stat_clear_snapshot()');
        const { rows } = await holder.query<{ blocked: number }>(
            `SELECT count(*)::int AS blocked FROM pg_stat_activity
             WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`,
        );
        if (rows[0].blocked >= count) return;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Never saw ${count} backends waiting on a lock.`);
}

/** Holds `householdId`'s row and moves `actorId` into it, uncommitted, until `act` waits on the row. */
async function joinWhileWaiting<T>(householdId: number, actorId: number, act: () => Promise<T>): Promise<T> {
    const holder = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    let result!: Promise<T>;
    try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM "Household" WHERE id = $1 FOR UPDATE', [householdId]);
        await holder.query('UPDATE "Person" SET "householdId" = $1 WHERE id = $2', [householdId, actorId]);
        result = act();
        result.catch(() => {});
        await waitForBlocked(holder, 1);
        await holder.query('COMMIT');
    } finally {
        await holder.end();
    }
    return result;
}

/** A sysadmin in a household of their own, signed in. */
async function joiner() {
    const n = seq++;
    const household = await prisma.household.create({ data: { name: `${TAG} joiner ${n}` } });
    const id = (await prisma.person.create({ data: { name: `Joiner ${n}`, email: `joiner-${n}-${TAG}@example.com`, householdId: household.id, isSysadmin: true } })).id;
    jest.mocked(getServerSession).mockResolvedValue({ user: { id, isSysadmin: true, isBoardMember: false } });
    return id;
}

/** A household with a lead and a second adult. */
async function family() {
    const n = seq++;
    const home = await prisma.household.create({ data: { name: `${TAG} home ${n}` } });
    await prisma.orgMembership.create({ data: { householdId: home.id, status: 'NONE' } });
    await prisma.person.create({ data: { name: `Lead ${n}`, email: `lead-${n}-${TAG}@example.com`, householdId: home.id, isHouseholdLead: true, isDeclaredAdult: true } });
    const adult = await prisma.person.create({ data: { name: `Adult ${n}`, email: `adult-${n}-${TAG}@example.com`, householdId: home.id, isDeclaredAdult: true } });
    return { homeId: home.id, adultId: adult.id };
}

const refusals = (actorId: number) => prisma.auditLog.count({ where: { actorId, tableName: SELF_GRANT_REFUSAL_TABLE } });

async function wipe() {
    const households = await prisma.household.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    const ids = households.map((h) => h.id);
    const people = await prisma.person.findMany({ where: { OR: [{ email: { contains: TAG } }, { householdId: { in: ids } }] }, select: { id: true } });
    const personIds = people.map((p) => p.id);
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: personIds } }, { affectedEntityId: { in: personIds }, tableName: 'Person' }] } });
    await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.household.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(wipe);

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

it('refuses adding a person to a household the actor joined while the add waited on its lock', async () => {
    const f = await family();
    const actor = await joiner();
    const name = `Added ${seq++} ${TAG}`;

    const res = await joinWhileWaiting(f.homeId, actor, () => addParticipant(new Request('http://localhost:4000/api/membership-ops/participants', {
        method: 'POST',
        body: JSON.stringify({ name, householdId: f.homeId }),
    }) as unknown as Parameters<typeof addParticipant>[0]));

    expect(res.status).toBe(403);
    expect(await refusals(actor)).toBe(1);
    expect(await prisma.person.count({ where: { name } })).toBe(0);
});

it('refuses promoting a lead in a household the actor joined while the promotion waited on its lock', async () => {
    const f = await family();
    const actor = await joiner();

    const res = await joinWhileWaiting(f.homeId, actor, () => promoteLead(new Request('http://localhost:4000/api/household/lead', {
        method: 'POST',
        body: JSON.stringify({ participantId: f.adultId }),
    }) as unknown as Parameters<typeof promoteLead>[0]));

    expect(res.status).toBe(403);
    expect(await refusals(actor)).toBe(1);
    expect((await prisma.person.findUniqueOrThrow({ where: { id: f.adultId } })).isHouseholdLead).toBe(false);
});
