/**
 * @jest-environment node
 */
/**
 * A program's leader keeps an email on file, against real Postgres: naming a leader
 * with none is refused on create and edit, and every write path that can blank a
 * person's email refuses while they lead a program that hasn't finished.
 */
import { POST as createProgram } from '@/app/api/programs/route';
import { PATCH as editProgram } from '@/app/api/programs/[id]/route';
import { PUT as boardEdit } from '@/app/api/membership-ops/participants/[id]/route';
import { PATCH as memberEdit } from '@/app/api/household/member/route';
import { POST as answerQuestion } from '@/app/api/profile/household-question/route';
import { prepareMerge } from '@/lib/person/merge/execute';
import { LEADER_EMAIL_REQUIRED, LEADER_NEEDS_EMAIL } from '@/lib/programs/leaderEligibility';
import type { AuthenticatedUser } from '@/types/auth';
import type { NextRequest } from 'next/server';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const TAG = 'leader-email-required-test';
let seq = 0;
const householdIds: number[] = [];
const programIds: number[] = [];

const signedInAs = (id: number, extra: object = {}) =>
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id, ...extra } });
const asBoard = () => signedInAs(boardId, { isSysadmin: false, isBoardMember: true });

const json = (url: string, method: string, body: unknown) =>
    new Request(url, { method, body: JSON.stringify(body) }) as unknown as NextRequest;

async function household() {
    const h = await prisma.household.create({ data: { name: `${TAG} household ${++seq}` } });
    householdIds.push(h.id);
    return h.id;
}

async function person(householdId: number, data: { email?: string | null; googleId?: string; isHouseholdLead?: boolean; householdJoinPending?: boolean } = {}) {
    seq += 1;
    return prisma.person.create({
        data: { email: `p${seq}-${TAG}@example.com`, name: 'Same Person', householdId, isDeclaredAdult: true, ...data },
    });
}

async function program(leadMentorId: number) {
    const p = await prisma.program.create({
        data: { name: `${TAG} program ${++seq}`, appliesToYear: 2099, startAt: new Date('2099-01-01'), endAt: new Date('2099-06-30'), phase: 'PLANNING', leadMentorId },
    });
    programIds.push(p.id);
    return p;
}

const finish = (programId: number) => prisma.program.update({ where: { id: programId }, data: { phase: 'FINISHED' } });
const reassign = (programId: number, leadMentorId: number) => prisma.program.update({ where: { id: programId }, data: { leadMentorId } });
const storedEmail = async (id: number) => (await prisma.person.findUniqueOrThrow({ where: { id }, select: { email: true } })).email;
const errorOf = async (res: Response) => (await res.json()).error;

let boardId: number;
let otherLeaderId: number;

beforeAll(async () => {
    boardId = (await person(await household(), { isHouseholdLead: true })).id;
    await prisma.person.update({ where: { id: boardId }, data: { isBoardMember: true } });
    otherLeaderId = (await person(await household(), { isHouseholdLead: true })).id;
});

afterAll(async () => {
    const people = await prisma.person.findMany({
        where: { OR: [{ householdId: { in: householdIds } }, { email: { contains: TAG } }] },
        select: { id: true, householdId: true },
    });
    const ids = people.map((p) => p.id);
    const households = [...new Set([...householdIds, ...people.map((p) => p.householdId)])];
    await prisma.program.deleteMany({ where: { OR: [{ id: { in: programIds } }, { leadMentorId: { in: ids } }] } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { affectedEntityId: { in: ids }, tableName: 'Person' }] } });
    await prisma.account.deleteMany({ where: { userId: { in: ids } } });
    await prisma.person.deleteMany({ where: { id: { in: ids } } });
    await prisma.orgMembership.deleteMany({ where: { householdId: { in: households } } });
    await prisma.household.deleteMany({ where: { id: { in: households } } });
});

describe('naming a program leader', () => {
    it('refuses a leader with no email when the program is created', async () => {
        const noEmail = await person(await household(), { email: null });
        asBoard();
        const res = await createProgram(json('http://localhost/api/programs', 'POST', {
            name: `${TAG} new`, leadMentorId: noEmail.id, startAt: '2099-01-01', endAt: '2099-06-30', maxParticipants: 5,
        }));
        expect(res.status).toBe(400);
        expect(await errorOf(res)).toBe(LEADER_NEEDS_EMAIL);
        expect(await prisma.program.count({ where: { name: `${TAG} new` } })).toBe(0);
    });

    it('refuses a new leader with no email on edit, keeping the old one', async () => {
        const prg = await program(otherLeaderId);
        const noEmail = await person(await household(), { email: null });
        asBoard();
        const res = await editProgram(json(`http://localhost/api/programs/${prg.id}`, 'PATCH', { leadMentorId: noEmail.id }), { params: Promise.resolve({ id: String(prg.id) }) });
        expect(res.status).toBe(400);
        expect(await errorOf(res)).toBe(LEADER_NEEDS_EMAIL);
        expect((await prisma.program.findUniqueOrThrow({ where: { id: prg.id } })).leadMentorId).toBe(otherLeaderId);
    });
});

describe('the Board clearing an email', () => {
    const put = (id: number, body: unknown) =>
        boardEdit(json(`http://localhost/api/membership-ops/participants/${id}`, 'PUT', body), { params: Promise.resolve({ id: String(id) }) });

    it('is refused while they lead an unfinished program', async () => {
        const leader = await person(await household());
        await program(leader.id);
        asBoard();
        for (const email of ['', null]) {
            const res = await put(leader.id, { email, emailChangeReason: 'Asked' });
            expect(res.status).toBe(409);
            expect(await errorOf(res)).toBe(LEADER_EMAIL_REQUIRED);
        }
        expect(await storedEmail(leader.id)).toBe(leader.email);
    });

    it('goes through once the program has finished', async () => {
        const leader = await person(await household());
        await finish((await program(leader.id)).id);
        asBoard();
        expect((await put(leader.id, { email: '', emailChangeReason: 'Asked' })).status).toBe(200);
        expect(await storedEmail(leader.id)).toBeNull();
    });

    it('goes through once another leader is named', async () => {
        const leader = await person(await household());
        await reassign((await program(leader.id)).id, otherLeaderId);
        asBoard();
        expect((await put(leader.id, { email: '', emailChangeReason: 'Asked' })).status).toBe(200);
    });

    it('still saves a leader\'s other fields when the email is left alone', async () => {
        const leader = await person(await household());
        await program(leader.id);
        asBoard();
        expect((await put(leader.id, { phone: '' })).status).toBe(200);
    });
});

describe('a household edit clearing an email', () => {
    const patch = (body: unknown) => memberEdit(json('http://localhost/api/household/member', 'PATCH', body), { params: Promise.resolve({}) });

    async function leadAndMember() {
        const householdId = await household();
        const lead = await person(householdId, { isHouseholdLead: true });
        const member = await person(householdId);
        return { lead, member };
    }

    it('is refused for a member who leads an unfinished program', async () => {
        const { lead, member } = await leadAndMember();
        await program(member.id);
        signedInAs(lead.id);
        const res = await patch({ participantId: member.id, email: '' });
        expect(res.status).toBe(409);
        expect(await errorOf(res)).toBe(LEADER_EMAIL_REQUIRED);
        expect(await storedEmail(member.id)).toBe(member.email);
    });

    it('is refused on a leader\'s own record', async () => {
        const { lead } = await leadAndMember();
        await program(lead.id);
        signedInAs(lead.id);
        expect((await patch({ participantId: lead.id, email: '' })).status).toBe(409);
    });

    it('goes through once the program has finished', async () => {
        const { lead, member } = await leadAndMember();
        await finish((await program(member.id)).id);
        signedInAs(lead.id);
        expect((await patch({ participantId: member.id, email: '' })).status).toBe(200);
        expect(await storedEmail(member.id)).toBeNull();
    });

    it('goes through once another leader is named', async () => {
        const { lead, member } = await leadAndMember();
        await reassign((await program(member.id)).id, otherLeaderId);
        signedInAs(lead.id);
        expect((await patch({ participantId: member.id, email: '' })).status).toBe(200);
    });
});

describe('a merge', () => {
    const board = () => ({ id: boardId, isSysadmin: false, isBoardMember: true }) as AuthenticatedUser;

    it('is refused when the keeper, a leader, takes the other side\'s email-less identity', async () => {
        const keep = await person(await household());
        const merge = await person(await household(), { email: null, googleId: `g${seq}-${TAG}` });
        const prg = await program(keep.id);
        const refused = await prepareMerge(board(), keep.id, merge.id, { identity: 'merge' }, 'Same person');
        expect(refused).toEqual({ refused: { status: 409, error: LEADER_EMAIL_REQUIRED } });

        await finish(prg.id);
        expect(await prepareMerge(board(), keep.id, merge.id, { identity: 'merge' }, 'Same person')).toHaveProperty('plan');
    });

    it('is refused when a leader\'s programs would pass to a keeper with no email', async () => {
        const keep = await person(await household(), { email: null, googleId: `g${seq}-${TAG}` });
        const merge = await person(await household());
        const prg = await program(merge.id);
        const refused = await prepareMerge(board(), keep.id, merge.id, { identity: 'keep' }, 'Same person');
        expect(refused).toEqual({ refused: { status: 409, error: LEADER_NEEDS_EMAIL } });

        await reassign(prg.id, otherLeaderId);
        expect(await prepareMerge(board(), keep.id, merge.id, { identity: 'keep' }, 'Same person')).toHaveProperty('plan');
    });
});

describe('answering no to the household question', () => {
    const answer = () => answerQuestion(json('http://localhost/api/profile/household-question', 'POST', { join: false }));

    it('is refused while the record leads an unfinished program, and goes through once it has finished', async () => {
        const householdId = await household();
        await person(householdId, { isHouseholdLead: true });
        const added = await person(householdId, { householdJoinPending: true });
        const prg = await program(added.id);
        signedInAs(added.id, { householdJoinPending: true });

        const res = await answer();
        expect(res.status).toBe(409);
        expect(await storedEmail(added.id)).toBe(added.email);

        await finish(prg.id);
        expect((await answer()).status).toBe(200);
        expect(await storedEmail(added.id)).toBeNull();
    });
});
