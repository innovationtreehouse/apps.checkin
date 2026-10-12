/**
 * @jest-environment node
 */
/**
 * Integration test for the per-row transaction guarantee (#360): one malformed
 * row among valid rows must NOT abort the batch. A row that fails up-front
 * validation (invalid email / invalid parent email) is skipped, surfaced in
 * errors[] naming its sheet row number, and never persisted — while the valid
 * rows around it still commit.
 */

import { POST } from '@/app/api/membership-ops/participants/import/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import * as xlsx from 'xlsx';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

describe('Bulk import: malformed row among valid rows', () => {
    let testAdminId: number;

    const cleanup = async () => {
        try {
            await prisma.orgMembership.deleteMany({});
            await prisma.person.deleteMany({ where: { email: { contains: 'malrow-import-test' } } });
            await prisma.person.deleteMany({ where: { name: { contains: 'Malrow Import Test' } } });
            await prisma.household.deleteMany({ where: { householdMembers: { none: {} } } });
        } catch {}
    };

    // The actor's email/name sit outside cleanup's patterns: cleanup runs after every
    // test, and an actor that no longer exists is refused by the route.
    const ACTOR_EMAIL = 'admin-malrow-actor@example.com';
    const removeActor = () => prisma.person.deleteMany({ where: { email: ACTOR_EMAIL } });

    beforeAll(async () => {
        await removeActor();
        await cleanup();
        const admin = await prisma.person.create({
            data: { email: ACTOR_EMAIL, name: 'Admin Malrow Actor', isSysadmin: true, household: { create: { name: "Test HH" } } }
        });
        testAdminId = admin.id;
        (getServerSession as jest.Mock).mockResolvedValue({
            user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
        });
    });

    afterAll(async () => {
        await removeActor();
        await cleanup();
    });
    afterEach(cleanup);

    const csvForm = (data: (string | number)[][]) => {
        const ws = xlsx.utils.aoa_to_sheet(data);
        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'csv' });
        const fd = new FormData();
        fd.append('file', new Blob([buffer], { type: 'text/csv' }), 'import.csv');
        return fd;
    };

    const post = async (data: (string | number)[][]) => {
        const fd = csvForm(data);
        const req = new Request('http://localhost:4000/api/membership-ops/participants/import', {
            method: 'POST', body: fd
        }) as unknown as Parameters<typeof POST>[0];
        (req as unknown as { formData: () => Promise<FormData> }).formData = jest.fn().mockResolvedValue(fd);
        const res = await POST(req);
        return { res, data: await res.json() };
    };

    it('invalid email on row 2 of 3: surrounding rows commit, bad row reported and not persisted', async () => {
        // Sheet rows -> reported row numbers: data row 1 = "Row 2", data row 2 = "Row 3", data row 3 = "Row 4".
        const { res, data } = await post([
            ['First Name', 'Last Name', 'Email'],
            ['Valid1', 'Malrow Import Test', 'valid1-malrow-import-test@example.com'],
            ['Bad', 'Malrow Import Test', 'not-an-email'],
            ['Valid3', 'Malrow Import Test', 'valid3-malrow-import-test@example.com'],
        ]);

        expect(res.status).toBe(200);
        expect(data.success).toBe(true);

        // Valid rows persisted...
        const valid1 = await prisma.person.findUnique({ where: { email: 'valid1-malrow-import-test@example.com' } });
        const valid3 = await prisma.person.findUnique({ where: { email: 'valid3-malrow-import-test@example.com' } });
        expect(valid1).not.toBeNull();
        expect(valid3).not.toBeNull();

        // ...bad row NOT persisted.
        const bad = await prisma.person.findFirst({ where: { name: 'Bad Malrow Import Test' } });
        expect(bad).toBeNull();
        const importedCount = await prisma.person.count({ where: { name: { contains: 'Malrow Import Test' }, NOT: { name: 'Admin Malrow Import Test' } } });
        expect(importedCount).toBe(2);

        // Bad row surfaced in errors[], naming the right sheet row (the 2nd data row = "Row 3").
        expect(Array.isArray(data.errors)).toBe(true);
        expect(data.errors).toHaveLength(1);
        expect(data.errors[0]).toContain('Row 3');
        expect(data.errors[0]).toContain('Invalid email format');

        // Counts: 2 imported / 1 error.
        expect(data.message).toContain('2 participants');
    });

    it('invalid parent email on row 2 of 3: surrounding rows commit, bad row reported and not persisted', async () => {
        const { res, data } = await post([
            ['First Name', 'Last Name', 'Email', 'Parent Email'],
            ['Valid1', 'Malrow Import Test', 'valid1-malrow-import-test@example.com', ''],
            ['BadParent', 'Malrow Import Test', '', 'not-an-email'],
            ['Valid3', 'Malrow Import Test', 'valid3-malrow-import-test@example.com', ''],
        ]);

        expect(res.status).toBe(200);
        expect(data.success).toBe(true);

        const valid1 = await prisma.person.findUnique({ where: { email: 'valid1-malrow-import-test@example.com' } });
        const valid3 = await prisma.person.findUnique({ where: { email: 'valid3-malrow-import-test@example.com' } });
        expect(valid1).not.toBeNull();
        expect(valid3).not.toBeNull();

        const bad = await prisma.person.findFirst({ where: { name: 'BadParent Malrow Import Test' } });
        expect(bad).toBeNull();
        const importedCount = await prisma.person.count({ where: { name: { contains: 'Malrow Import Test' }, NOT: { name: 'Admin Malrow Import Test' } } });
        expect(importedCount).toBe(2);

        expect(data.errors).toHaveLength(1);
        expect(data.errors[0]).toContain('Row 3');
        expect(data.errors[0]).toContain('Invalid parent email format');
        expect(data.message).toContain('2 participants');
    });
});
