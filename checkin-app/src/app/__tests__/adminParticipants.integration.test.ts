/**
 * @jest-environment node
 */
/**
 * Integration Tests for Admin Participants API
 * Tests POST (create participant with parent/household logic)
 */

import { POST } from '@/app/api/membership-ops/participants/route';
import { PUT } from '@/app/api/membership-ops/participants/[id]/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { expectAuditRow, auditJson } from '@/test-helpers/expectAuditRow';

// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

describe('Admin Participants API Integration Tests', () => {
    let testAdminId: number;
    let testUserId: number;

    // Scoping membership deletes to exactly the households these
    // filters own (not a blanket deleteMany({})) matters: this suite runs
    // alongside ~285 other integration files sharing one DB per jest worker, and
    // an unscoped wipe of every Membership row would silently
    // corrupt their fixtures.
    //
    // Two scopes, matching the two lifetimes in this file: the admin/user
    // fixtures below are created once in beforeAll and must survive every
    // individual test, torn down only by afterAll; PER_TEST_EMAIL_FILTERS is
    // what individual tests create and afterEach must clean between tests
    // WITHOUT touching the persistent admin/user fixtures.
    const PERSISTENT_EMAIL_FILTERS = [{ email: { contains: 'participants-test' } }];
    const PER_TEST_EMAIL_FILTERS = [
        { email: { contains: 'new-child-participants-test' } },
        { email: { contains: 'new-lone-participants-test' } },
        { email: { contains: 'new-parent-participants-test' } },
        { email: { contains: 'edit-test-user' } },
        { email: 'updated-email@example.com' },
    ];

    /** Delete participants matching `filters`, their memberships, then sweep any household left empty. */
    async function wipe(filters: Array<Record<string, unknown>>) {
        const rows = await prisma.person.findMany({ where: { OR: filters }, select: { householdId: true } });
        const householdIds = [...new Set(rows.map((r) => r.householdId).filter((id): id is number => id != null))];
        if (householdIds.length) {
            await prisma.orgMembership.deleteMany({ where: { householdId: { in: householdIds } } });
        }
        await prisma.person.deleteMany({ where: { OR: filters } });
        // Only sweep households the deletion above emptied — a household this file
        // doesn't own could share a similar name (e.g. "Test Household"), and the
        // Participant->Household FK is RESTRICT.
        if (householdIds.length) {
            await prisma.household.deleteMany({ where: { id: { in: householdIds }, householdMembers: { none: {} } } });
        }
    }

    beforeAll(async () => {
        // Clean up any leaked state from a prior failed run.
        await wipe(PERSISTENT_EMAIL_FILTERS);

        // Setup mock database records
        const admin = await prisma.person.create({
            data: { email: 'admin-participants-test@example.com', name: 'Admin Test', isSysadmin: true, household: { create: { name: "Test HH" } } }
        });
        testAdminId = admin.id;

        const user = await prisma.person.create({
            data: { email: 'user-participants-test@example.com', name: 'User Test', household: { create: { name: "Test HH" } } }
        });
        testUserId = user.id;
    });

    afterAll(() => wipe(PERSISTENT_EMAIL_FILTERS));

    afterEach(() => wipe(PER_TEST_EMAIL_FILTERS));

    describe('POST /api/membership-ops/participants', () => {
        it('should return 403 Forbidden for non-admin users', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({
                 user: { id: testUserId, isSysadmin: false, isBoardMember: false }
             });

             const req = new Request('http://localhost:4000/api/membership-ops/participants', {
                 method: 'POST',
                 body: JSON.stringify({ name: 'Test', email: 'test@example.com' })
             });

             const res = await POST(req as unknown as Parameters<typeof POST>[0]);
             expect(res.status).toBe(403);
        });

        it('should return 400 Bad Request if no email, parentEmail, or householdId is provided', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            const req = new Request('http://localhost:4000/api/membership-ops/participants', {
                method: 'POST',
                body: JSON.stringify({ name: 'Test No Email' })
            });

            const res = await POST(req as unknown as Parameters<typeof POST>[0]);
            expect(res.status).toBe(400);
            
            const data = await res.json();
            expect(data.error).toContain('Email, Parent Email, or Household assignment is required');
        });

        it('should return 400 Bad Request if name is missing', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            const req = new Request('http://localhost:4000/api/membership-ops/participants', {
                method: 'POST',
                body: JSON.stringify({ email: 'new-lone-participants-test-noname@example.com' })
            });

            const res = await POST(req as unknown as Parameters<typeof POST>[0]);
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toMatch(/name/i);
        });

        it('should return 400 Bad Request if name is blank', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            const req = new Request('http://localhost:4000/api/membership-ops/participants', {
                method: 'POST',
                body: JSON.stringify({ name: '   ', email: 'new-lone-participants-test-blank@example.com' })
            });

            const res = await POST(req as unknown as Parameters<typeof POST>[0]);
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toMatch(/name/i);
        });

        it('trims leading/trailing whitespace from a submitted name', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            const req = new Request('http://localhost:4000/api/membership-ops/participants', {
                method: 'POST',
                body: JSON.stringify({ name: '  Trimmed Name  ', email: 'new-lone-participants-test-trim@example.com' })
            });

            const res = await POST(req as unknown as Parameters<typeof POST>[0]);
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.participant.name).toBe('Trimmed Name');
        });

        it('should return 400 Bad Request if email format is invalid', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            const req = new Request('http://localhost:4000/api/membership-ops/participants', {
                method: 'POST',
                body: JSON.stringify({ name: 'Test Invalid Email', email: 'invalid-email' })
            });

            const res = await POST(req as unknown as Parameters<typeof POST>[0]);
            expect(res.status).toBe(400);
            
            const data = await res.json();
            expect(data.error).toContain('Invalid email format');
        });

        it('should return 409 Conflict if participant with email already exists', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            const req = new Request('http://localhost:4000/api/membership-ops/participants', {
                method: 'POST',
                body: JSON.stringify({ name: 'Duplicate Email Test', email: 'admin-participants-test@example.com' })
            });

            const res = await POST(req as unknown as Parameters<typeof POST>[0]);
            expect(res.status).toBe(409);
            
            const data = await res.json();
            expect(data.error).toContain('already exists');
        });

        it('should create a lone participant and auto-generate a household for them', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            const req = new Request('http://localhost:4000/api/membership-ops/participants', {
                method: 'POST',
                body: JSON.stringify({ name: 'Lone Adult', email: 'new-lone-participants-test@example.com' })
            });

            const res = await POST(req as unknown as Parameters<typeof POST>[0]);
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.success).toBe(true);
            expect(data.participant.email).toBe('new-lone-participants-test@example.com');

            // The API returns the participant created BEFORE the household is linked since it does not refetch
            // We should just verify it exists in the DB correctly
            const updatedParticipant = await prisma.person.findUnique({
                where: { id: data.participant.id }
            });
            expect(updatedParticipant?.householdId).not.toBeNull();
            // Verify the household was actually created
            const household = await prisma.household.findUnique({
                where: { id: updatedParticipant!.householdId! }
            });
            expect(household).toBeDefined();
            expect(household?.name).toBe('Adult Household');

            // D4.5: admin-created participants default to visitors (no membership)
            const membership = await prisma.orgMembership.findUnique({
                where: { householdId: updatedParticipant!.householdId! }
            });
            expect(membership).toBeNull();
        });

        it('should reject alreadyMember with 400 and create no participant or membership', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            const req = new Request('http://localhost:4000/api/membership-ops/participants', {
                method: 'POST',
                body: JSON.stringify({
                    name: 'Paid Adult',
                    email: 'new-paid-participants-test@example.com',
                    alreadyMember: true
                })
            });

            const res = await POST(req as unknown as Parameters<typeof POST>[0]);
            expect(res.status).toBe(400);

            const created = await prisma.person.findUnique({
                where: { email: 'new-paid-participants-test@example.com' }
            });
            expect(created).toBeNull();
        });

        it('should create a child participant and auto-generate a parent and household if parentEmail does not exist', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            const req = new Request('http://localhost:4000/api/membership-ops/participants', {
                method: 'POST',
                body: JSON.stringify({
                    name: 'Child User',
                    email: 'new-child-participants-test@example.com',
                    parentEmail: 'new-parent-participants-test@example.com',
                    parentName: 'New Parent'
                })
            });

            const res = await POST(req as unknown as Parameters<typeof POST>[0]);
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.success).toBe(true);
            expect(data.participant.email).toBe('new-child-participants-test@example.com');
            expect(data.participant.householdId).not.toBeNull();

            // Verify the parent was created with the provided name
            const parent = await prisma.person.findUnique({
                where: { email: 'new-parent-participants-test@example.com' }
            });
            expect(parent).toBeDefined();
            expect(parent?.name).toBe('New Parent');
            expect(parent?.householdId).toBe(data.participant.householdId);
        });

        it('should reject creating a child with parentEmail but no parentName when parent does not exist', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            const req = new Request('http://localhost:4000/api/membership-ops/participants', {
                method: 'POST',
                body: JSON.stringify({
                    name: 'Child User',
                    email: 'reject-child-participants-test@example.com',
                    parentEmail: 'reject-parent-participants-test@example.com'
                })
            });

            const res = await POST(req as unknown as Parameters<typeof POST>[0]);
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toMatch(/parent name/i);
        });
    });

    describe('PUT /api/membership-ops/participants/[id]', () => {
        it('should return 403 Forbidden for non-admin users', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({
                 user: { id: testUserId, isSysadmin: false, isBoardMember: false }
             });

             const req = new Request(`http://localhost:4000/api/membership-ops/participants/${testUserId}`, {
                 method: 'PUT',
                 body: JSON.stringify({ name: 'Hacked Name' })
             });

             const res = await PUT(req as unknown as Parameters<typeof PUT>[0], { params: Promise.resolve({ id: testUserId.toString() }) });
             expect(res.status).toBe(403);
        });

        it('should successfully update a participant name, email, and phone', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            // Create a disposable user just for this edit test
            const editUser = await prisma.person.create({
                data: { email: 'edit-test-user@example.com', name: 'Original Name', household: { create: { name: "Test HH" } } }
            });

            const req = new Request(`http://localhost:4000/api/membership-ops/participants/${editUser.id}`, {
                method: 'PUT',
                body: JSON.stringify({ name: 'Updated Name', email: 'updated-email@example.com', phone: '5551234567' })
            });

            const res = await PUT(req as unknown as Parameters<typeof PUT>[0], { params: Promise.resolve({ id: editUser.id.toString() }) });
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.participant.name).toBe('Updated Name');
            expect(data.participant.email).toBe('updated-email@example.com');
            // The route formats via formatPhone() before saving (dashed, not raw digits).
            expect(data.participant.phone).toBe('555-123-4567');

            // Verify the DB actually saved it
            const dbCheck = await prisma.person.findUnique({ where: { id: editUser.id } });
            expect(dbCheck?.name).toBe('Updated Name');
            expect(dbCheck?.phone).toBe('555-123-4567');

            // PII edits MUST leave an audit trail naming the acting admin and the
            // before/after of the field — a regression dropping the actor or the
            // log fails right here.
            const log = await expectAuditRow(prisma, { action: 'EDIT', tableName: 'Person', affectedEntityId: editUser.id });
            expect(log.actorId).toBe(testAdminId);
            expect(auditJson(log.oldData).name).toBe('Original Name');
            expect(auditJson(log.newData).name).toBe('Updated Name');

            // Cleanup is handled by afterEach
        });

        it('rejects blanking a participant name via PUT and leaves the stored name alone', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            const editUser = await prisma.person.create({
                data: { email: 'edit-test-user-blank@example.com', name: 'Keep This Name', household: { create: { name: "Test HH" } } }
            });

            const req = new Request(`http://localhost:4000/api/membership-ops/participants/${editUser.id}`, {
                method: 'PUT',
                body: JSON.stringify({ name: '   ' })
            });

            const res = await PUT(req as unknown as Parameters<typeof PUT>[0], { params: Promise.resolve({ id: editUser.id.toString() }) });
            expect(res.status).toBe(400);

            const dbCheck = await prisma.person.findUnique({ where: { id: editUser.id } });
            expect(dbCheck?.name).toBe('Keep This Name');
        });

        it('sets the over-25 declaration on a person with no date of birth', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            const adult = await prisma.person.create({
                data: { email: 'edit-test-user-nodob@example.com', name: 'Adult No DOB', household: { create: { name: "Test HH" } } },
            });

            const req = new Request(`http://localhost:4000/api/membership-ops/participants/${adult.id}`, {
                method: 'PUT',
                body: JSON.stringify({ isDeclaredAdult: true })
            });

            const res = await PUT(req as unknown as Parameters<typeof PUT>[0], { params: Promise.resolve({ id: adult.id.toString() }) });
            expect(res.status).toBe(200);

            const dbCheck = await prisma.person.findUnique({ where: { id: adult.id } });
            expect(dbCheck?.isDeclaredAdult).toBe(true);
        });

        it('drops the over-25 declaration when the person has a date of birth on file', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            // A 12-year-old already carrying a stale flag, as a bulk import that writes
            // a DOB without touching it leaves them. The edit form resubmits the whole
            // record, so an unrelated name edit must still save AND heal the pair — a
            // declared-adult flag here would make them match the adults filter in
            // /api/people/search and count as a supervising adult in the safety calc.
            const youth = await prisma.person.create({
                data: {
                    email: 'edit-test-user-dob@example.com',
                    name: 'Youth With DOB',
                    dateOfBirth: new Date(Date.UTC(2014, 0, 15)),
                    isDeclaredAdult: true,
                    household: { create: { name: "Test HH" } },
                },
            });

            const req = new Request(`http://localhost:4000/api/membership-ops/participants/${youth.id}`, {
                method: 'PUT',
                body: JSON.stringify({ name: 'Youth Renamed', isDeclaredAdult: true })
            });

            const res = await PUT(req as unknown as Parameters<typeof PUT>[0], { params: Promise.resolve({ id: youth.id.toString() }) });
            expect(res.status).toBe(200);

            const dbCheck = await prisma.person.findUnique({ where: { id: youth.id } });
            expect(dbCheck?.name).toBe('Youth Renamed');
            expect(dbCheck?.isDeclaredAdult).toBe(false);
            // The DOB is the authoritative value — dropping the flag must not clear it.
            expect(dbCheck?.dateOfBirth).toEqual(new Date(Date.UTC(2014, 0, 15)));
        });

        it('allows clearing the over-25 declaration on a person with a date of birth', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            const youth = await prisma.person.create({
                data: {
                    email: 'edit-test-user-dob@example.com',
                    name: 'Youth With DOB',
                    dateOfBirth: new Date(Date.UTC(2014, 0, 15)),
                    isDeclaredAdult: true,
                    household: { create: { name: "Test HH" } },
                },
            });

            const req = new Request(`http://localhost:4000/api/membership-ops/participants/${youth.id}`, {
                method: 'PUT',
                body: JSON.stringify({ isDeclaredAdult: false })
            });

            const res = await PUT(req as unknown as Parameters<typeof PUT>[0], { params: Promise.resolve({ id: youth.id.toString() }) });
            expect(res.status).toBe(200);

            const dbCheck = await prisma.person.findUnique({ where: { id: youth.id } });
            expect(dbCheck?.isDeclaredAdult).toBe(false);
        });
    });
});
