/**
 * @jest-environment node
 */
/**
 * Integration Tests for Admin Bulk Participant Import API
 * Tests CSV file uploads, parsing, household generation, and merging
 */

import { POST } from '@/app/api/membership-ops/participants/import/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import * as xlsx from 'xlsx';

// Mock NextAuth
jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

// The CSV import module is optional and off by default.
process.env.CSV_IMPORT_ENABLED = 'true';

describe('Admin Bulk Import API Integration Tests', () => {
    let testAdminId: number;
    let testUserId: number;

    beforeAll(async () => {
        try {
            // Clean up any leaked state
            await prisma.orgMembership.deleteMany({});
            await prisma.person.deleteMany({
                where: { email: { contains: 'import-test' } }
            });
            await prisma.person.deleteMany({
                where: { name: { contains: 'Import Test' } }
            });
            await prisma.household.deleteMany({
                where: { name: { contains: 'Import Test' } }
            });
            await prisma.household.deleteMany({
                where: { name: { contains: 'Household' } }
            });
        } catch {}

        // Setup mock database records
        const admin = await prisma.person.create({
            data: { email: 'admin-import-test@example.com', name: 'Admin Import Test', isSysadmin: true, household: { create: { name: "Test HH" } } }
        });
        testAdminId = admin.id;

        const user = await prisma.person.create({
            data: { email: 'user-import-test@example.com', name: 'User Import Test', household: { create: { name: "Test HH" } } }
        });
        testUserId = user.id;
    });

    afterAll(async () => {
        try {
            // Clean up
            await prisma.orgMembership.deleteMany({});
            await prisma.person.deleteMany({
                where: { email: { contains: 'import-test' } }
            });
            await prisma.person.deleteMany({
                where: { name: { contains: 'Import Test' } }
            });
            await prisma.household.deleteMany({
                where: { name: { contains: 'Import Test' } }
            });
            await prisma.household.deleteMany({
                where: { name: { contains: 'Household' } }
            });
        } catch {}
    });

    afterEach(async () => {
        try {
            // Clean up participants created during tests
            await prisma.auditLog.deleteMany({ where: { actorId: testAdminId } });
            await prisma.paymentException.deleteMany({ where: { kind: 'DENIED_HOUSEHOLD_ACTIVITY' } });
            await prisma.orgMembership.deleteMany({});
            await prisma.person.deleteMany({
                where: { email: { contains: 'batch-import-test' } }
            });
            await prisma.person.deleteMany({
                where: { name: { contains: 'Batch Import Test' } }
            });
            await prisma.household.deleteMany({
                where: { name: { contains: 'Household' } }
            });
        } catch {}
    });

    const createMockCsvFormData = (data: (string | number | boolean | Date)[][]) => {
        const worksheet = xlsx.utils.aoa_to_sheet(data);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
        const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'csv' });
        
        const blob = new Blob([buffer], { type: 'text/csv' });
        const formData = new FormData();
        formData.append('file', blob, 'import.csv');
        return formData;
    };

    describe('POST /api/membership-ops/participants/import', () => {
        it('should return 403 Forbidden for non-admin users', async () => {
             (getServerSession as jest.Mock).mockResolvedValue({
                 user: { id: testUserId, isSysadmin: false, isBoardMember: false }
             });

             const req = new Request('http://localhost:4000/api/membership-ops/participants/import', {
                 method: 'POST',
             });

             const res = await POST(req as unknown as Parameters<typeof POST>[0]);
             expect(res.status).toBe(403);
        });

        it('should return 400 Bad Request if no file is provided', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            const formData = new FormData();
            const req = new Request('http://localhost:4000/api/membership-ops/participants/import', {
                method: 'POST',
                body: formData
            }) as unknown as Parameters<typeof POST>[0];
            (req as unknown as { formData: () => Promise<FormData> }).formData = jest.fn().mockResolvedValue(formData);

            const res = await POST(req);
            expect(res.status).toBe(400);
            
            const data = await res.json();
            expect(data.error).toBe('No file provided');
        });

        it('should return 400 Bad Request if required columns are missing', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            // Missing Last Name column
            const formData = createMockCsvFormData([
                ['First Name', 'Email'],
                ['John', 'john@example.com']
            ]);

            const req = new Request('http://localhost:4000/api/membership-ops/participants/import', {
                method: 'POST',
                body: formData
            }) as unknown as Parameters<typeof POST>[0];
            (req as unknown as { formData: () => Promise<FormData> }).formData = jest.fn().mockResolvedValue(formData);

            const res = await POST(req);
            expect(res.status).toBe(400);
            
            const data = await res.json();
            expect(data.error).toContain("Missing required 'First Name' or 'Last Name' columns");
        });

        it('should successfully import a batch of new participants and link their households', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            const formData = createMockCsvFormData([
                ['First Name', 'Last Name', 'Email', 'Parent Email', 'Same Household As'],
                ['Alice', 'Batch Import Test', 'alice-batch-import-test@example.com', '', ''],
                ['Bob', 'Batch Import Test', '', 'alice-batch-import-test@example.com', ''], // Child of Alice using parent email
                ['Charlie', 'Batch Import Test', 'charlie-batch-import-test@example.com', '', 'Alice Batch Import Test'], // Adult in Alice's household using name reference
            ]);

            const req = new Request('http://localhost:4000/api/membership-ops/participants/import', {
                method: 'POST',
                body: formData
            }) as unknown as Parameters<typeof POST>[0];
            (req as unknown as { formData: () => Promise<FormData> }).formData = jest.fn().mockResolvedValue(formData);

            const res = await POST(req);
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.success).toBe(true);
            expect(data.message).toContain('3 participants');

            // Verify Alice
            const alice = await prisma.person.findUnique({ where: { email: 'alice-batch-import-test@example.com' } });
            expect(alice).toBeDefined();
            expect(alice?.householdId).not.toBeNull();

            // Verify Bob
            const bob = await prisma.person.findFirst({ where: { name: 'Bob Batch Import Test' } });
            expect(bob).toBeDefined();
            expect(bob?.householdId).toBe(alice?.householdId);

            // Verify Charlie
            const charlie = await prisma.person.findUnique({ where: { email: 'charlie-batch-import-test@example.com' } });
            expect(charlie).toBeDefined();
            expect(charlie?.householdId).toBe(alice?.householdId);

            // Charlie's own pass-1 household was deleted by the merge — the pre-image
            // of the destroyed household is on record.
            const audit = await prisma.auditLog.findFirst({
                where: { tableName: 'Household', action: 'DELETE', secondaryAffectedEntity: alice!.householdId },
                orderBy: { id: 'desc' },
            });
            expect(audit?.actorId).toBe(testAdminId);
            expect(audit?.oldData).toMatchObject({ household: { name: "Charlie Batch Import Test's Household" } });
            expect(audit?.newData).toMatchObject({ mergedIntoHouseholdId: alice!.householdId, movedByImportOfPersonId: charlie!.id });
        });

        it("refuses a Same Household As merge into the actor's own household, leaving the row's household as it was", async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });
            const admin = await prisma.person.findUniqueOrThrow({ where: { id: testAdminId }, select: { householdId: true } });

            const formData = createMockCsvFormData([
                ['First Name', 'Last Name', 'Email', 'Parent Email', 'Same Household As'],
                ['Dana', 'Batch Import Test', 'dana-batch-import-test@example.com', '', 'admin-import-test@example.com'],
            ]);
            const req = new Request('http://localhost:4000/api/membership-ops/participants/import', {
                method: 'POST',
                body: formData
            }) as unknown as Parameters<typeof POST>[0];
            (req as unknown as { formData: () => Promise<FormData> }).formData = jest.fn().mockResolvedValue(formData);

            const res = await POST(req);
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.errors).toEqual([expect.stringContaining('your own household')]);

            const dana = await prisma.person.findUnique({ where: { email: 'dana-batch-import-test@example.com' } });
            expect(dana).not.toBeNull();
            expect(dana!.householdId).not.toBe(admin.householdId);
        });

        it('should automatically create households for participants with no household links, and correctly assign lead status based on age', async () => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });

            const formData = createMockCsvFormData([
                ['First Name', 'Last Name', 'DOB'],
                ['Adult', 'Import Test', '1990-01-01'],
                ['Youth', 'Import Test', '2015-01-01'],
                ['Default', 'Import Test', ''], 
            ]);

            const req = new Request('http://localhost:4000/api/membership-ops/participants/import', {
                method: 'POST',
                body: formData
            }) as unknown as Parameters<typeof POST>[0];
            (req as unknown as { formData: () => Promise<FormData> }).formData = jest.fn().mockResolvedValue(formData);
            const res = await POST(req);
            const data = await res.json();
            if (data.errors) console.log("Import Errors:", data.errors);
            expect(res.status).toBe(200);
            
            const adult = await prisma.person.findFirst({ where: { name: 'Adult Import Test' } });
            expect(adult).not.toBeNull();
            expect(adult!.householdId).not.toBeNull();
            
            const adultLead = await prisma.person.findFirst({ where: { id: adult!.id, isHouseholdLead: true }, select: { id: true } });
            // In some environments, lead assignment might delay or fail if the household creation isn't atomic.
            // But here it should be present.
            expect(adultLead).not.toBeNull();

            const youth = await prisma.person.findFirst({ where: { name: 'Youth Import Test' } });
            expect(youth).not.toBeNull();
            expect(youth!.householdId).not.toBeNull();
            const youthLead = await prisma.person.findFirst({ where: { id: youth!.id, isHouseholdLead: true }, select: { id: true } });
            expect(youthLead).toBeNull();

            const defaultAdult = await prisma.person.findFirst({ where: { name: 'Default Import Test' } });
            expect(defaultAdult?.householdId).not.toBeNull();
            const defaultLead = await prisma.person.findFirst({ where: { id: defaultAdult?.id, isHouseholdLead: true }, select: { id: true } });
            expect(defaultLead).not.toBeNull();
        });

        const importAs = async (rows: string[][]) => {
            (getServerSession as jest.Mock).mockResolvedValue({
                user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
            });
            const formData = createMockCsvFormData(rows);
            const req = new Request('http://localhost:4000/api/membership-ops/participants/import', {
                method: 'POST',
                body: formData
            }) as unknown as Parameters<typeof POST>[0];
            (req as unknown as { formData: () => Promise<FormData> }).formData = jest.fn().mockResolvedValue(formData);
            return POST(req);
        };

        it('404s when the CSV import module is off', async () => {
            process.env.CSV_IMPORT_ENABLED = 'false';
            try {
                const res = await importAs([['First Name', 'Last Name'], ['Off', 'Batch Import Test']]);
                expect(res.status).toBe(404);
            } finally {
                process.env.CSV_IMPORT_ENABLED = 'true';
            }
            expect(await prisma.person.findFirst({ where: { name: 'Off Batch Import Test' } })).toBeNull();
        });

        it('moves a NONE household to ACTIVE with an audit row; a DENIED one is left alone and raised to the board', async () => {
            const noneParent = await prisma.person.create({
                data: { email: 'none-parent-batch-import-test@example.com', name: 'None Parent Batch Import Test', household: { create: { name: 'None Batch Household' } } }
            });
            const noneMembership = await prisma.orgMembership.create({ data: { householdId: noneParent.householdId, status: 'NONE' } });
            const deniedParent = await prisma.person.create({
                data: { email: 'denied-parent-batch-import-test@example.com', name: 'Denied Parent Batch Import Test', household: { create: { name: 'Denied Batch Household' } } }
            });
            await prisma.orgMembership.create({ data: { householdId: deniedParent.householdId, status: 'DENIED' } });

            const res = await importAs([
                ['First Name', 'Last Name', 'Email', 'Parent Email'],
                ['Kid', 'None Batch Import Test', '', 'none-parent-batch-import-test@example.com'],
                ['Kid', 'Denied Batch Import Test', '', 'denied-parent-batch-import-test@example.com'],
            ]);
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.errors).toEqual([expect.stringMatching(/Denied Batch Import Test.*is DENIED/)]);

            expect((await prisma.orgMembership.findUnique({ where: { householdId: noneParent.householdId } }))?.status).toBe('ACTIVE');
            expect((await prisma.orgMembership.findUnique({ where: { householdId: deniedParent.householdId } }))?.status).toBe('DENIED');
            expect(await prisma.paymentException.findFirst({ where: { kind: 'DENIED_HOUSEHOLD_ACTIVITY', personId: deniedParent.id } })).not.toBeNull();
            const audit = await prisma.auditLog.findFirst({ where: { tableName: 'OrgMembership', affectedEntityId: noneMembership.id } });
            expect(audit).toMatchObject({ actorId: testAdminId, oldData: { status: 'NONE' }, newData: { status: 'ACTIVE' } });
        });

        it('refuses to merge a household whose membership status is not NONE, keeping that status', async () => {
            const target = await prisma.person.create({
                data: { email: 'target-batch-import-test@example.com', name: 'Target Batch Import Test', household: { create: { name: 'Target Batch Household' } } }
            });
            const source = await prisma.person.create({
                data: { email: 'source-batch-import-test@example.com', name: 'Source Batch Import Test', household: { create: { name: 'Source Batch Household' } } }
            });
            await prisma.orgMembership.create({ data: { householdId: source.householdId, status: 'DENIED' } });

            const res = await importAs([
                ['First Name', 'Last Name', 'Email', 'Same Household As'],
                ['Source', 'Batch Import Test', 'source-batch-import-test@example.com', 'target-batch-import-test@example.com'],
            ]);
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.errors).toEqual([expect.stringContaining('merge refused')]);

            expect((await prisma.person.findUniqueOrThrow({ where: { id: source.id } })).householdId).toBe(source.householdId);
            expect((await prisma.orgMembership.findUnique({ where: { householdId: source.householdId } }))?.status).toBe('DENIED');
            expect((await prisma.person.findUniqueOrThrow({ where: { id: target.id } })).householdId).toBe(target.householdId);
        });
    });
});
