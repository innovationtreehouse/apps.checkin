/**
 * @jest-environment node
 */
/**
 * Integration Test for Program Age Boundaries
 * Ensures that the system correctly enforces minAge and maxAge bounds during self-enrollment blocks,
 * while allowing Administrators to override the blocks manually.
 */

import { POST as enrollParticipant } from '@/app/api/programs/[id]/participants/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));
// Mock Notifications to avoid external calls
jest.mock('@/lib/notifications', () => ({
    sendNotification: jest.fn()
}));

// The program's start date, and the anchor every birthdate fixture is measured
// from. A literal, not the real clock: reconstructing today's month/day N years
// back only round-trips when that day exists in the target year, which Feb 29
// does not. Jun 15 has a counterpart in every year, and a day on either side.
const NOW = new Date('2026-06-15T12:00:00.000Z');

describe('Program Age Bounds Integration Tests', () => {
    let testAdminId: number;
    let guardianUserId: number;
    let validUserId: number;
    let underageUserId: number;
    let overageUserId: number;
    let noDobUserId: number;
    let exactlyMinUserId: number;
    let exactlyMaxUserId: number;
    let turns14TomorrowUserId: number;
    let turned19YesterdayUserId: number;
    let testProgramId: number;

    beforeAll(async () => {
        // Birthdates are relative to NOW, which is also the program's start date —
        // the instant the enroll route judges age against (calculateAge(dob,
        // program.startAt)).
        // Built in UTC because calculateAge() compares UTC date components — a
        // local-midnight fixture lands on the wrong UTC day off-zero-offset and
        // shifts the "day before/after the birthday" cases by a year.
        const dobYearsAgo = (years: number, dayOffset = 0) =>
            new Date(Date.UTC(NOW.getUTCFullYear() - years, NOW.getUTCMonth(), NOW.getUTCDate() + dayOffset));
        const dob16 = dobYearsAgo(16);
        const dob12 = dobYearsAgo(12);
        const dob20 = dobYearsAgo(20);
        // Exact boundaries for program [minAge=14, maxAge=18].
        // Birthday is the start date => exactly N years old then (eligible at both ends).
        const dobExactly14 = dobYearsAgo(14);
        const dobExactly18 = dobYearsAgo(18);
        // Birthday the day after, born 14 years ago => still 13 on the start date (under).
        const dobTurns14Tomorrow = dobYearsAgo(14, 1);
        // Birthday the day before, born 19 years ago => turned 19 already (over).
        const dobTurned19Yesterday = dobYearsAgo(19, -1);

        // Clean up any leaked state from previous runs
        await prisma.auditLog.deleteMany({});
        await prisma.programParticipant.deleteMany({});
        await prisma.programVolunteer.deleteMany({});
        await prisma.event.deleteMany({});
        await prisma.programInstance.deleteMany({});
        await prisma.program.deleteMany({});
        await prisma.person.deleteMany({
            where: { email: { contains: 'age-test' } }
        });

        // Setup mock database records
        const admin = await prisma.person.create({
            data: { email: 'admin-age-test@example.com', name: 'Admin Age Test', isSysadmin: true, household: { create: { name: "Test HH" } } }
        });
        testAdminId = admin.id;

        // Eligible-age youth live in a household with an adult lead: only a lead
        // may enroll a participant under 18 (docs/rules/programs.md).
        const guardianHousehold = await prisma.household.create({ data: { name: "Test HH" } });
        const guardian = await prisma.person.create({
            data: {
                email: 'guardian-age-test@example.com',
                name: 'Guardian Age Test',
                dateOfBirth: dobYearsAgo(40),
                isHouseholdLead: true,
                householdId: guardianHousehold.id,
            }
        });
        guardianUserId = guardian.id;

        const pValid = await prisma.person.create({
            data: { email: 'valid-age-test@example.com', name: 'Valid Age Test', dateOfBirth: dob16, householdId: guardianHousehold.id }
        });
        validUserId = pValid.id;

        const pUnder = await prisma.person.create({
            data: { email: 'underage-test@example.com', name: 'Underage Test', dateOfBirth: dob12, household: { create: { name: "Test HH" } } }
        });
        underageUserId = pUnder.id;

        const pOver = await prisma.person.create({
            data: { email: 'overage-test@example.com', name: 'Overage Test', dateOfBirth: dob20, household: { create: { name: "Test HH" } } }
        });
        overageUserId = pOver.id;

        const pNoDob = await prisma.person.create({
            data: { email: 'no-dob-test@example.com', name: 'No DOB Test', household: { create: { name: "Test HH" } } }
        });
        noDobUserId = pNoDob.id;

        const pExactlyMin = await prisma.person.create({
            data: { email: 'exactly-min-age-test@example.com', name: 'Exactly Min Age Test', dateOfBirth: dobExactly14, householdId: guardianHousehold.id }
        });
        exactlyMinUserId = pExactlyMin.id;

        const pExactlyMax = await prisma.person.create({
            data: { email: 'exactly-max-age-test@example.com', name: 'Exactly Max Age Test', dateOfBirth: dobExactly18, household: { create: { name: "Test HH" } } }
        });
        exactlyMaxUserId = pExactlyMax.id;

        const pTurns14Tomorrow = await prisma.person.create({
            data: { email: 'turns-14-tomorrow-age-test@example.com', name: 'Turns 14 Tomorrow Test', dateOfBirth: dobTurns14Tomorrow, household: { create: { name: "Test HH" } } }
        });
        turns14TomorrowUserId = pTurns14Tomorrow.id;

        const pTurned19Yesterday = await prisma.person.create({
            data: { email: 'turned-19-yesterday-age-test@example.com', name: 'Turned 19 Yesterday Test', dateOfBirth: dobTurned19Yesterday, household: { create: { name: "Test HH" } } }
        });
        turned19YesterdayUserId = pTurned19Yesterday.id;

        const program = await prisma.program.create({
            data: {
                name: 'Age Bounds Integration Test Program',
                minAge: 14,
                maxAge: 18,
                startAt: NOW,
                endAt: new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1000),
                phase: 'UPCOMING',
                enrollmentStatus: 'OPEN'
            }
        });
        testProgramId = program.id;
    });

    afterAll(async () => {
        // Clean up
        if (testProgramId !== undefined) {
            await prisma.programParticipant.deleteMany({ where: { programId: testProgramId } });
            await prisma.programInstance.deleteMany({ where: { programId: testProgramId } });
            await prisma.program.deleteMany({ where: { id: testProgramId } });
        }

        const actorIds = [testAdminId, guardianUserId, validUserId, underageUserId, overageUserId, noDobUserId, exactlyMinUserId, exactlyMaxUserId, turns14TomorrowUserId, turned19YesterdayUserId].filter(id => id !== undefined);
        if (actorIds.length > 0) {
            await prisma.auditLog.deleteMany({
                where: { actorId: { in: actorIds } }
            });
            await prisma.person.deleteMany({
                where: { id: { in: actorIds } }
            });
        }
    });

    afterEach(async () => {
        // Ensure enrollments are wiped clean after each test to prevent ID conflicts
        await prisma.programParticipant.deleteMany({ where: { programId: testProgramId } });
    });

    it('should allow a household lead to enroll a participant within the valid age range', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({
            user: { id: guardianUserId, isSysadmin: false, isBoardMember: false }
        });

        const req = new Request(`http://localhost:4000/api/programs/${testProgramId}/participants`, {
            method: 'POST',
            body: JSON.stringify({ participantId: validUserId })
        });

        const res = await enrollParticipant(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: testProgramId.toString() }) });
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.success).toBe(true);
    });

    it('should block self-enrollment for an underage participant', async () => {
        // Mock session to underage user
        (getServerSession as jest.Mock).mockResolvedValue({
            user: { id: underageUserId, isSysadmin: false, isBoardMember: false }
        });

        const req = new Request(`http://localhost:4000/api/programs/${testProgramId}/participants`, {
            method: 'POST',
            body: JSON.stringify({ participantId: underageUserId })
        });

        const res = await enrollParticipant(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: testProgramId.toString() }) });
        expect(res.status).toBe(400);

        const data = await res.json();
        expect(data.error).toContain('least 14 years old');
        expect(data.requiresOverride).toBe(true);
    });

    it('should block self-enrollment for an overage participant', async () => {
        // Mock session to overage user
        (getServerSession as jest.Mock).mockResolvedValue({
            user: { id: overageUserId, isSysadmin: false, isBoardMember: false }
        });

        const req = new Request(`http://localhost:4000/api/programs/${testProgramId}/participants`, {
            method: 'POST',
            body: JSON.stringify({ participantId: overageUserId })
        });

        const res = await enrollParticipant(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: testProgramId.toString() }) });
        expect(res.status).toBe(400);

        const data = await res.json();
        expect(data.error).toContain('maximum age is 18 years old');
        expect(data.requiresOverride).toBe(true);
    });

    it('should block self-enrollment for a participant missing Date of Birth', async () => {
        // Mock session to no-dob user
        (getServerSession as jest.Mock).mockResolvedValue({
            user: { id: noDobUserId, isSysadmin: false, isBoardMember: false }
        });

        const req = new Request(`http://localhost:4000/api/programs/${testProgramId}/participants`, {
            method: 'POST',
            body: JSON.stringify({ participantId: noDobUserId })
        });

        const res = await enrollParticipant(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: testProgramId.toString() }) });
        expect(res.status).toBe(400);

        const data = await res.json();
        expect(data.error).toBe('Participant Date of Birth is missing.');
        expect(data.requiresOverride).toBe(true);
    });

    it('should allow enrollment for a participant who is EXACTLY minAge today (birthday today)', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({
            user: { id: guardianUserId, isSysadmin: false, isBoardMember: false }
        });

        const req = new Request(`http://localhost:4000/api/programs/${testProgramId}/participants`, {
            method: 'POST',
            body: JSON.stringify({ participantId: exactlyMinUserId })
        });

        const res = await enrollParticipant(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: testProgramId.toString() }) });
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.success).toBe(true);
    });

    it('should allow self-enrollment for a participant who is EXACTLY maxAge', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({
            user: { id: exactlyMaxUserId, isSysadmin: false, isBoardMember: false }
        });

        const req = new Request(`http://localhost:4000/api/programs/${testProgramId}/participants`, {
            method: 'POST',
            body: JSON.stringify({ participantId: exactlyMaxUserId })
        });

        const res = await enrollParticipant(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: testProgramId.toString() }) });
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.success).toBe(true);
    });

    it('should block a participant who only turns minAge tomorrow (still under today)', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({
            user: { id: turns14TomorrowUserId, isSysadmin: false, isBoardMember: false }
        });

        const req = new Request(`http://localhost:4000/api/programs/${testProgramId}/participants`, {
            method: 'POST',
            body: JSON.stringify({ participantId: turns14TomorrowUserId })
        });

        const res = await enrollParticipant(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: testProgramId.toString() }) });
        expect(res.status).toBe(400);

        const data = await res.json();
        expect(data.error).toContain('least 14 years old');
        expect(data.requiresOverride).toBe(true);
    });

    it('should block a participant who turned maxAge+1 yesterday (now over)', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({
            user: { id: turned19YesterdayUserId, isSysadmin: false, isBoardMember: false }
        });

        const req = new Request(`http://localhost:4000/api/programs/${testProgramId}/participants`, {
            method: 'POST',
            body: JSON.stringify({ participantId: turned19YesterdayUserId })
        });

        const res = await enrollParticipant(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: testProgramId.toString() }) });
        expect(res.status).toBe(400);

        const data = await res.json();
        expect(data.error).toContain('maximum age is 18 years old');
        expect(data.requiresOverride).toBe(true);
    });

    it('should allow an Administrator to override Age bounds and enroll an underage participant', async () => {
        // Mock session to isSysadmin user
        (getServerSession as jest.Mock).mockResolvedValue({
            user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
        });

        const req = new Request(`http://localhost:4000/api/programs/${testProgramId}/participants`, {
            method: 'POST',
            body: JSON.stringify({ participantId: underageUserId, override: true })
        });

        const res = await enrollParticipant(req as unknown as import("next/server").NextRequest, { params: Promise.resolve({ id: testProgramId.toString() }) });
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.success).toBe(true);
    });
});
