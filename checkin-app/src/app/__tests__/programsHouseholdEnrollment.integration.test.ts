/**
 * @jest-environment node
 */
/**
 * Integration tests for MULTI-SELECT household enrollment (PR #541).
 *
 * The feature lives client-side in programs/[id]/page.tsx: it loops the
 * single-participant POST /api/programs/[id]/participants once per selected
 * household member. The server route only ever sees one id, so the loop's
 * emergent behavior — several sequential POSTs by one household lead into one
 * program — was never exercised end to end. This drives that sequence against a
 * real Postgres and pins:
 *   (a) every member's enrollment row persists;
 *   (b) a 409-mixed-with-new pass leaves a consistent set (no dup, new enrolled);
 *   (c) capacity: N selected > remaining seats → PARTIAL enroll up to capacity
 *       (each POST locks+counts independently; the client loop continues past a
 *       400), NOT all-or-nothing.
 */

import { POST } from '@/app/api/programs/[id]/participants/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));
jest.mock('@/lib/notifications', () => ({
    sendNotification: jest.fn()
}));

describe('Multi-select household enrollment (integration)', () => {
    let leadId: number;
    let depAId: number;
    let depBId: number;
    let depCId: number;

    let freeProgramId: number;
    let cappedProgramId: number;

    const TAG = 'household-enroll-test';

    const cleanup = async () => {
        const users = await prisma.person.findMany({
            where: { email: { contains: TAG } },
            select: { id: true }
        });
        const ids = users.map(u => u.id);
        if (ids.length) {
            await prisma.programParticipant.deleteMany({ where: { personId: { in: ids } } });
            await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
        }
        await prisma.program.deleteMany({ where: { name: { contains: 'Household Enroll Test' } } });
        if (ids.length) {
            await prisma.person.deleteMany({ where: { id: { in: ids } } });
        }
    };

    beforeAll(async () => {
        await cleanup();

        // One household: a lead + three adult dependents (no age limits in play).
        const household = await prisma.household.create({ data: { name: "Test HH" } });
        const lead = await prisma.person.create({
            // Adult DOB: the lead self-enrolls below, and only a known adult may.
            data: {
                email: `lead-${TAG}@example.com`,
                name: 'HH Lead',
                dateOfBirth: new Date(Date.now() - (30 * 31556952000)),
                householdId: household.id,
            }
        });
        leadId = lead.id;
        const mkDep = async (label: string) => (await prisma.person.create({
            data: {
                email: `${label}-${TAG}@example.com`,
                name: `Dep ${label}`,
                dateOfBirth: new Date(Date.now() - (30 * 31556952000)),
                householdId: household.id
            }
        })).id;
        depAId = await mkDep('a');
        depBId = await mkDep('b');
        depCId = await mkDep('c');
        await prisma.person.update({
            where: { id: leadId },
            data: { isHouseholdLead: true }
        });

        const free = await prisma.program.create({
            data: { appliesToYear: 2026, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Household Enroll Test Free', phase: 'RUNNING', enrollmentStatus: 'OPEN', offSaleAt: new Date('2999-01-01'), orgMemberPriceCents: null, nonOrgMemberPriceCents: null }
        });
        freeProgramId = free.id;

        // Cap = 2: the lead will try to enroll 3 members.
        const capped = await prisma.program.create({
            data: { appliesToYear: 2026, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Household Enroll Test Capped', phase: 'RUNNING', enrollmentStatus: 'OPEN', offSaleAt: new Date('2999-01-01'), maxParticipants: 2 }
        });
        cappedProgramId = capped.id;
    });

    afterAll(async () => {
        await cleanup();
    });

    const params = (id: number) => ({ params: Promise.resolve({ id: id.toString() }) }) as unknown as never;

    // The client loops this POST per selected member; mirror that here.
    const enroll = (programId: number, participantId: number) => POST(
        new Request(`http://localhost:4000/api/programs/${programId}/participants`, {
            method: 'POST',
            body: JSON.stringify({ participantId })
        }) as unknown as import('next/server').NextRequest,
        params(programId)
    );

    it('(a) persists an enrollment row for every selected household member', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });

        for (const pid of [leadId, depAId, depBId, depCId]) {
            const res = await enroll(freeProgramId, pid);
            expect(res.status).toBe(200);
        }

        const rows = await prisma.programParticipant.findMany({
            where: { programId: freeProgramId },
            select: { personId: true }
        });
        expect(rows.map(r => r.personId).sort((x, y) => x - y))
            .toEqual([leadId, depAId, depBId, depCId].sort((x, y) => x - y));
    });

    it('(b) a 409 (already enrolled) mixed with a new member leaves a consistent set — no dup, new enrolled', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });

        // depA already enrolled from test (a). Re-selecting it (UI offered it again
        // / override retry) hits the unique PK and must come back a clean 409...
        const dup = await enroll(freeProgramId, depAId);
        expect(dup.status).toBe(409);
        expect((await dup.json()).error).toMatch(/already enrolled/i);

        // ...while a genuinely new member in the same pass still enrolls. (depA..C
        // were all enrolled in (a); use the lead's re-pass shape: drop depB then
        // re-add to prove the new-row path coexists with the 409.)
        await prisma.programParticipant.delete({
            where: { programId_personId: { programId: freeProgramId, personId: depBId } }
        });
        const fresh = await enroll(freeProgramId, depBId);
        expect(fresh.status).toBe(200);

        // Exactly one row for depA (no duplicate) and depB is back.
        expect(await prisma.programParticipant.count({
            where: { programId: freeProgramId, personId: depAId }
        })).toBe(1);
        expect(await prisma.programParticipant.count({
            where: { programId: freeProgramId, personId: depBId }
        })).toBe(1);
    });

    it('(c) selecting more members than remaining seats partially enrolls up to capacity', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: leadId } });

        // Cap = 2, enroll 3 in sequence (the client loop continues past a 400).
        const r1 = await enroll(cappedProgramId, leadId);
        const r2 = await enroll(cappedProgramId, depAId);
        const r3 = await enroll(cappedProgramId, depBId);

        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
        // Third exceeds the cap: 400 with requiresOverride, NOT all-or-nothing
        // (the first two stay enrolled).
        expect(r3.status).toBe(400);
        const data = await r3.json();
        expect(data.error).toMatch(/maximum capacity/);
        expect(data.requiresOverride).toBe(true);

        const enrolled = await prisma.programParticipant.findMany({
            where: { programId: cappedProgramId },
            select: { personId: true }
        });
        expect(enrolled).toHaveLength(2);
        expect(enrolled.map(r => r.personId).sort((x, y) => x - y))
            .toEqual([leadId, depAId].sort((x, y) => x - y));
    });
});
