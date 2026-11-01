/**
 * @jest-environment node
 */
/**
 * Integration tests for the "new program announced" notification trigger.
 *
 * Both program-edit PATCH routes fire notifyNewProgramAnnounced through
 * maybeAnnounceOnOpen (src/lib/programAnnounce.ts): ONLY on the transition INTO
 * (phase=UPCOMING && enrollmentStatus=OPEN), and at most once per program
 * lifetime (the announcedAt claim). These guard: it fires on the edge, does NOT
 * re-fire (already-open edit, close-and-reopen, stale-pre-state race), does NOT
 * fire when only one of the two conditions flips, and audits the blast.
 */

import { PATCH } from '@/app/api/programs/[id]/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { notifyNewProgramAnnounced } from '@/lib/notifications';
import { maybeAnnounceOnOpen } from '@/lib/programAnnounce';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));
jest.mock('@/lib/notifications', () => ({
    // route.ts's fire-without-await edge does `notifyNewProgramAnnounced(...).catch(...)`
    // — the mock must resolve so `.catch` is defined.
    notifyNewProgramAnnounced: jest.fn().mockResolvedValue(undefined),
}));

const PROGRAM_NAME_TAG = 'Announce Notify Test Program';
const mockNotify = notifyNewProgramAnnounced as jest.Mock;

const patch = (id: number, body: Record<string, unknown>) =>
    PATCH(
        new Request(`http://localhost:4000/api/programs/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
        }) as unknown as Request,
        { params: Promise.resolve({ id: String(id) }) },
    );

describe('New-program announce notification trigger', () => {
    let adminId: number;
    let leadId: number;

    beforeAll(async () => {
        const existingUsers = await prisma.person.findMany({
            where: { email: { contains: 'announce-notify-test' } },
            select: { id: true },
        });
        const existingUserIds = existingUsers.map(u => u.id);
        await prisma.program.deleteMany({ where: { name: { contains: PROGRAM_NAME_TAG } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: existingUserIds } } });
        await prisma.person.deleteMany({ where: { id: { in: existingUserIds } } });

        const admin = await prisma.person.create({
            data: { email: 'admin-announce-notify-test@example.com', name: 'Admin', isSysadmin: true, household: { create: { name: "Test HH" } } },
        });
        adminId = admin.id;
        const lead = await prisma.person.create({
            data: { email: 'lead-announce-notify-test@example.com', name: 'Lead', household: { create: { name: "Test HH" } } },
        });
        leadId = lead.id;
    });

    afterAll(async () => {
        const ids = [adminId, leadId];
        await prisma.event.deleteMany({ where: { program: { name: { contains: PROGRAM_NAME_TAG } } } });
        await prisma.program.deleteMany({ where: { name: { contains: PROGRAM_NAME_TAG } } });
        await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
        await prisma.person.deleteMany({ where: { id: { in: ids } } });
    });

    beforeEach(() => {
        jest.clearAllMocks();
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });
    });

    it('fires once when a program crosses INTO UPCOMING + OPEN (announceOnOpen: true)', async () => {
        const name = `${PROGRAM_NAME_TAG} cross`;
        const program = await prisma.program.create({
            data: { appliesToYear: 2026, offSaleAt: new Date('2999-01-01'), name, leadMentorId: leadId, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), phase: 'PLANNING', enrollmentStatus: 'CLOSED', announceOnOpen: true },
        });
        await prisma.event.create({ data: { programId: program.id, name: 'E', startAt: new Date('2099-01-01'), endAt: new Date('2099-01-01') } });

        const res = await patch(program.id, { phase: 'UPCOMING', enrollmentStatus: 'OPEN' });
        expect(res.status).toBe(200);
        expect(mockNotify).toHaveBeenCalledTimes(1);
        expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ name }));
    });

    it('does NOT fire when crossing INTO UPCOMING + OPEN with announceOnOpen left at its false default', async () => {
        const name = `${PROGRAM_NAME_TAG} default-off`;
        const program = await prisma.program.create({
            data: { appliesToYear: 2026, offSaleAt: new Date('2999-01-01'), name, leadMentorId: leadId, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), phase: 'PLANNING', enrollmentStatus: 'CLOSED' },
        });
        await prisma.event.create({ data: { programId: program.id, name: 'E', startAt: new Date('2099-01-01'), endAt: new Date('2099-01-01') } });

        const res = await patch(program.id, { phase: 'UPCOMING', enrollmentStatus: 'OPEN' });
        expect(res.status).toBe(200);
        expect(mockNotify).not.toHaveBeenCalled();
    });

    it('does NOT re-fire on a later edit while already UPCOMING + OPEN', async () => {
        const name = `${PROGRAM_NAME_TAG} already`;
        const program = await prisma.program.create({
            data: { appliesToYear: 2026, offSaleAt: new Date('2999-01-01'), name, leadMentorId: leadId, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), phase: 'UPCOMING', enrollmentStatus: 'OPEN', announceOnOpen: true },
        });

        const res = await patch(program.id, { name: `${name} renamed` });
        expect(res.status).toBe(200);
        expect(mockNotify).not.toHaveBeenCalled();
    });

    it('does NOT fire when only phase flips to UPCOMING (enrollment still CLOSED)', async () => {
        const name = `${PROGRAM_NAME_TAG} phaseonly`;
        const program = await prisma.program.create({
            data: { appliesToYear: 2026, offSaleAt: new Date('2999-01-01'), name, leadMentorId: leadId, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), phase: 'PLANNING', enrollmentStatus: 'CLOSED', announceOnOpen: true },
        });
        await prisma.event.create({ data: { programId: program.id, name: 'E', startAt: new Date('2099-01-01'), endAt: new Date('2099-01-01') } });

        const res = await patch(program.id, { phase: 'UPCOMING' });
        expect(res.status).toBe(200);
        expect(mockNotify).not.toHaveBeenCalled();
    });

    it('does NOT fire when only enrollment flips to OPEN (phase still PLANNING)', async () => {
        const name = `${PROGRAM_NAME_TAG} enrollonly`;
        const program = await prisma.program.create({
            data: { appliesToYear: 2026, offSaleAt: new Date('2999-01-01'), name, leadMentorId: leadId, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), phase: 'PLANNING', enrollmentStatus: 'CLOSED', announceOnOpen: true },
        });

        const res = await patch(program.id, { enrollmentStatus: 'OPEN' });
        expect(res.status).toBe(200);
        expect(mockNotify).not.toHaveBeenCalled();
    });

    // announcedAt is a once-per-program-lifetime claim.
    describe('once-per-lifetime announcedAt claim', () => {
        it('sets announcedAt on the first fire, and closing + reopening enrollment does NOT re-fire (F2)', async () => {
            const name = `${PROGRAM_NAME_TAG} reopen`;
            const program = await prisma.program.create({
                data: { appliesToYear: 2026, offSaleAt: new Date('2999-01-01'), name, leadMentorId: leadId, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), phase: 'PLANNING', enrollmentStatus: 'CLOSED', announceOnOpen: true },
            });
            await prisma.event.create({ data: { programId: program.id, name: 'E', startAt: new Date('2099-01-01'), endAt: new Date('2099-01-01') } });

            expect((await patch(program.id, { phase: 'UPCOMING', enrollmentStatus: 'OPEN' })).status).toBe(200);
            expect(mockNotify).toHaveBeenCalledTimes(1);

            const announced = await prisma.program.findUnique({ where: { id: program.id } });
            expect(announced?.announcedAt).not.toBeNull();

            // Close, then reopen — a row compare would fire again here.
            expect((await patch(program.id, { enrollmentStatus: 'CLOSED' })).status).toBe(200);
            expect((await patch(program.id, { enrollmentStatus: 'OPEN' })).status).toBe(200);
            expect(mockNotify).toHaveBeenCalledTimes(1);

            // announcedAt unchanged by the reopen.
            const after = await prisma.program.findUnique({ where: { id: program.id } });
            expect(after?.announcedAt).toEqual(announced?.announcedAt);
        });

        it('two callers with the same stale pre-state send only once (F3 — conditional-write contract)', async () => {
            const name = `${PROGRAM_NAME_TAG} race`;
            const program = await prisma.program.create({
                data: { appliesToYear: 2026, offSaleAt: new Date('2999-01-01'), name, leadMentorId: leadId, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), phase: 'PLANNING', enrollmentStatus: 'CLOSED', announceOnOpen: true },
            });
            const after = await prisma.program.update({
                where: { id: program.id },
                data: { phase: 'UPCOMING', enrollmentStatus: 'OPEN' },
            });

            // Both calls hold the SAME pre-update snapshot — exactly what two
            // concurrent PATCHes observe. Only the updateMany claim may win once.
            await maybeAnnounceOnOpen({ programId: program.id, before: program, after, actorId: adminId });
            await maybeAnnounceOnOpen({ programId: program.id, before: program, after, actorId: adminId });

            expect(mockNotify).toHaveBeenCalledTimes(1);
        });

        it('writes an AuditLog row for the blast with the triggering actor (F6)', async () => {
            const name = `${PROGRAM_NAME_TAG} audit`;
            const program = await prisma.program.create({
                data: { appliesToYear: 2026, offSaleAt: new Date('2999-01-01'), name, leadMentorId: leadId, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), phase: 'PLANNING', enrollmentStatus: 'CLOSED', announceOnOpen: true },
            });
            await prisma.event.create({ data: { programId: program.id, name: 'E', startAt: new Date('2099-01-01'), endAt: new Date('2099-01-01') } });

            expect((await patch(program.id, { phase: 'UPCOMING', enrollmentStatus: 'OPEN' })).status).toBe(200);

            const rows = await prisma.auditLog.findMany({
                where: { tableName: 'Program', affectedEntityId: program.id, actorId: adminId },
            });
            const blastRows = rows.filter(
                (r) => (r.newData as { event?: string } | null)?.event === 'PROGRAM_ANNOUNCE_BLAST',
            );
            expect(blastRows).toHaveLength(1);
            expect((blastRows[0].newData as { announcedAt?: string }).announcedAt).toBeDefined();
        });
    });
});
