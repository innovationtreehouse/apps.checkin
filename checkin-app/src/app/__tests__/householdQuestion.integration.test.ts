/**
 * @jest-environment node
 */
/**
 * Board ruling B1/B2, 2026-10-27: nobody joins a household at first sign-in without
 * their own yes. Drives the real adapter link and answer route against real Postgres.
 */
import { GET, POST } from '@/app/api/profile/household-question/route';
import { GET as householdGET } from '@/app/api/household/route';
import { PUT as boardEdit } from '@/app/api/membership-ops/participants/[id]/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/config', () => {
    const actual = jest.requireActual('@/lib/config');
    return {
        __esModule: true,
        ...actual,
        config: {
            ...actual.config,
            nextAuthSecret: jest.fn(() => 'test-secret'),
            googleClientId: jest.fn(() => 'gid'),
            googleClientSecret: jest.fn(() => 'gsecret'),
        },
    };
});
jest.unmock('@/lib/auth-options');

import { authOptions } from '@/lib/auth-options';

const adapter = authOptions.adapter as unknown as { linkAccount: (account: Record<string, unknown>) => Promise<unknown> };

const TAG = 'household-question-test';
const idToken = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const url = 'http://localhost/api/profile/household-question';
const answer = (join: unknown) => POST(new Request(url, { method: 'POST', body: JSON.stringify({ join }) }));
const ask = () => GET(new Request(url));
const youthDob = () => new Date(Date.now() - 10 * 365 * 864e5);

let seq = 0;
const householdIds: number[] = [];

async function household(status?: 'DENIED') {
    const h = await prisma.household.create({
        data: { name: `${TAG} household`, ...(status && { orgMembership: { create: { status } } }) },
    });
    householdIds.push(h.id);
    return h.id;
}

const addPerson = (householdId: number, data: { dateOfBirth?: Date; isHouseholdLead?: boolean } = {}) => {
    seq += 1;
    return prisma.person.create({
        data: { email: `p${seq}-${TAG}@example.com`, name: 'Name the household typed', householdId, ...data },
    });
};

const link = (userId: number, claims: object = { name: 'Google Name' }) => {
    seq += 1;
    return adapter.linkAccount({
        userId: String(userId), type: 'oauth', provider: 'google', providerAccountId: `${TAG}-${seq}`, id_token: idToken(claims),
    });
};

/** A household someone has signed in to, with one more adult added to it by email. */
async function addedAdult(status?: 'DENIED') {
    const householdId = await household(status);
    const adder = await addPerson(householdId, { isHouseholdLead: true });
    await link(adder.id);
    const added = await addPerson(householdId);
    await link(added.id);
    return { householdId, added };
}

const signedInAs = (id: number, extra: object = {}) =>
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id, ...extra } });
const pending = async (id: number) => (await prisma.person.findUniqueOrThrow({ where: { id } })).householdJoinPending;

afterAll(async () => {
    const people = await prisma.person.findMany({
        where: { OR: [{ email: { contains: TAG } }, { householdId: { in: householdIds } }] },
        select: { id: true, householdId: true },
    });
    const ids = people.map((p) => p.id);
    const households = [...new Set([...householdIds, ...people.map((p) => p.householdId)])];
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.personRole.deleteMany({ where: { personId: { in: ids } } });
    await prisma.account.deleteMany({ where: { userId: { in: ids } } });
    await prisma.person.deleteMany({ where: { id: { in: ids } } });
    await prisma.orgMembership.deleteMany({ where: { householdId: { in: households } } });
    await prisma.household.deleteMany({ where: { id: { in: households } } });
});

describe('first sign-in asks', () => {
    it('an adult added to a household someone has signed in to, with or without a date of birth', async () => {
        const { added } = await addedAdult();
        expect(added.dateOfBirth).toBeNull();
        expect(await pending(added.id)).toBe(true);
    });

    it('nobody on a later account', async () => {
        const { added } = await addedAdult();
        signedInAs(added.id, { householdJoinPending: true });
        await answer(true);
        await link(added.id);
        expect(await pending(added.id)).toBe(false);
    });

    it('not a youth, who stays in the household that added them', async () => {
        const householdId = await household();
        const adder = await addPerson(householdId, { isHouseholdLead: true });
        await link(adder.id);
        const youth = await addPerson(householdId, { dateOfBirth: youthDob() });
        await link(youth.id);
        expect(await pending(youth.id)).toBe(false);
        expect((await prisma.person.findUniqueOrThrow({ where: { id: youth.id } })).householdId).toBe(householdId);
    });

    it('not someone in a household where nobody has signed in', async () => {
        const householdId = await household();
        const lead = await addPerson(householdId, { isHouseholdLead: true });
        await addPerson(householdId);
        await link(lead.id);
        expect(await pending(lead.id)).toBe(false);
    });
});

describe('while the question is open', () => {
    it('refuses every other route', async () => {
        const { added } = await addedAdult();
        signedInAs(added.id, { householdJoinPending: true });
        expect((await householdGET(new Request('http://localhost/api/household'))).status).toBe(401);
    });

    it('shows the household name and nothing of the record', async () => {
        const { added } = await addedAdult();
        signedInAs(added.id, { householdJoinPending: true });
        const res = await ask();
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ householdName: `${TAG} household` });
    });
});

describe('a yes', () => {
    it('joins: the question closes on the same record and household', async () => {
        const { householdId, added } = await addedAdult();
        signedInAs(added.id, { householdJoinPending: true });
        expect((await answer(true)).status).toBe(200);
        const after = await prisma.person.findUniqueOrThrow({ where: { id: added.id }, include: { accounts: true } });
        expect(after).toMatchObject({ householdJoinPending: false, householdId, email: added.email });
        expect(after.accounts).toHaveLength(1);
    });
});

describe('a no', () => {
    it('leaves the record in the household without the address, and the account on a new empty person', async () => {
        const { householdId, added } = await addedAdult();
        await prisma.person.update({ where: { id: added.id }, data: { isHouseholdLead: true, phone: '555-0100' } });
        await prisma.personRole.create({ data: { personId: added.id, role: 'KEYHOLDER' } });
        signedInAs(added.id, { householdJoinPending: true });

        expect((await answer(false)).status).toBe(200);

        const old = await prisma.person.findUniqueOrThrow({ where: { id: added.id }, include: { accounts: true, roles: true } });
        expect(old).toMatchObject({ householdId, email: null, isHouseholdLead: true, householdJoinPending: false, name: 'Name the household typed', phone: '555-0100' });
        expect(old.accounts).toHaveLength(0);
        expect(old.roles).toHaveLength(1);

        const fresh = await prisma.person.findUniqueOrThrow({ where: { email: added.email! }, include: { accounts: true, roles: true } });
        expect(fresh.id).not.toBe(added.id);
        expect(fresh.householdId).not.toBe(householdId);
        expect(fresh).toMatchObject({ name: 'Google Name', phone: null, dateOfBirth: null, isHouseholdLead: true, householdJoinPending: false });
        expect(fresh.accounts).toHaveLength(1);
        expect(fresh.roles).toHaveLength(0);
    });
});

describe('refusals', () => {
    it('refuses both answers in a denied household, and the denied session itself', async () => {
        const { added } = await addedAdult('DENIED');
        signedInAs(added.id, { householdJoinPending: true });
        for (const join of [true, false]) expect((await answer(join)).status).toBe(403);
        signedInAs(added.id, { householdJoinPending: true, denied: true });
        expect((await answer(false)).status).toBe(401);
        expect(await pending(added.id)).toBe(true);
    });

    it('refuses a youth both answers', async () => {
        const { added } = await addedAdult();
        await prisma.person.update({ where: { id: added.id }, data: { dateOfBirth: youthDob() } });
        signedInAs(added.id, { householdJoinPending: true });
        for (const join of [true, false]) expect((await answer(join)).status).toBe(403);
        expect(await pending(added.id)).toBe(true);
    });

    it('lets the Board close it for someone it marks a youth; a sysadmin off the Board cannot', async () => {
        const { added } = await addedAdult();
        await prisma.person.update({ where: { id: added.id }, data: { dateOfBirth: youthDob() } });
        const edit = () => boardEdit(new Request(`http://localhost/api/membership-ops/participants/${added.id}`, {
            method: 'PUT', body: JSON.stringify({ name: 'Corrected' }),
        }) as never, { params: Promise.resolve({ id: String(added.id) }) });
        const outsider = await addPerson(await household());

        signedInAs(outsider.id, { isSysadmin: true });
        await edit();
        expect(await pending(added.id)).toBe(true);

        signedInAs(outsider.id, { isBoardMember: true });
        expect((await edit()).status).toBe(200);
        expect(await pending(added.id)).toBe(false);
    });

    it('refuses someone with no open question', async () => {
        const person = await addPerson(await household());
        signedInAs(person.id);
        expect((await answer(false)).status).toBe(409);
        expect((await ask()).status).toBe(409);
        expect((await prisma.person.findUniqueOrThrow({ where: { id: person.id } })).email).toBe(person.email);
    });

    it('rejects an answer that is not true or false', async () => {
        const { added } = await addedAdult();
        signedInAs(added.id, { householdJoinPending: true });
        expect((await answer('no')).status).toBe(400);
    });
});
