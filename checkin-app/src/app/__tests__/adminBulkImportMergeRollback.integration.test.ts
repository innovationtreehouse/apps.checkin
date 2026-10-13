/**
 * @jest-environment node
 */
/**
 * Integration test for the "Same Household As" merge rollback.
 *
 * The merge moves an entire source household into a target and then deletes the
 * source. It runs inside prisma.$transaction, so a failure mid-sequence must
 * leave NO partial state: participants stay in the source household and the
 * source household still exists. We force the failure with a real constraint —
 * a TrustedAdult row on the source household has a RESTRICT FK to Household and
 * the merge does not clear it, so the final source-household delete throws.
 */

import { POST } from '@/app/api/membership-ops/participants/import/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import * as xlsx from 'xlsx';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

const TARGET_EMAIL = 'target-anchor-mergeroll-test@example.com';
const SOURCE_EMAIL = 'source-member-mergeroll-test@example.com';

// The CSV import module is optional and off by default.
process.env.CSV_IMPORT_ENABLED = 'true';

describe('Bulk import merge rollback', () => {
    let testAdminId: number;
    let targetHouseholdId: number;
    let sourceHouseholdId: number;
    let sourceMemberId: number;

    const cleanup = async () => {
        try {
            await prisma.trustedAdult.deleteMany({ where: { trustedAdultName: 'Grandma Mergeroll' } });
            await prisma.orgMembership.deleteMany({});
            await prisma.person.deleteMany({ where: { email: { contains: 'mergeroll-test' } } });
            await prisma.household.deleteMany({ where: { householdMembers: { none: {} } } });
        } catch {}
    };

    beforeAll(async () => {
        await cleanup();

        const admin = await prisma.person.create({
            data: { email: 'admin-mergeroll-test@example.com', name: 'Admin Mergeroll Test', isSysadmin: true, household: { create: { name: "Test HH" } } }
        });
        testAdminId = admin.id;

        const target = await prisma.person.create({
            data: { email: TARGET_EMAIL, name: 'Target Anchor Mergeroll Test', household: { create: { name: "Test HH" } } },
            select: { householdId: true }
        });
        targetHouseholdId = target.householdId;

        const source = await prisma.person.create({
            data: { email: SOURCE_EMAIL, name: 'Source Member Mergeroll Test', household: { create: { name: "Test HH" } } },
            select: { id: true, householdId: true }
        });
        sourceMemberId = source.id;
        sourceHouseholdId = source.householdId;

        // RESTRICT FK to the source household that the merge never clears — this
        // is what makes the final household.delete throw mid-transaction.
        await prisma.trustedAdult.create({
            data: {
                householdId: sourceHouseholdId,
                trustedAdultName: 'Grandma Mergeroll',
                trustedAdultPhone: '555-0100',
                familyContext: 'Can pick up the kids.',
                disclosedById: testAdminId,
            }
        });
    });

    afterAll(cleanup);

    const csvForm = (data: (string | number)[][]) => {
        const ws = xlsx.utils.aoa_to_sheet(data);
        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'csv' });
        const fd = new FormData();
        fd.append('file', new Blob([buffer], { type: 'text/csv' }), 'import.csv');
        return fd;
    };

    it('rolls back the whole merge when the source-household delete fails', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({
            user: { id: testAdminId, isSysadmin: true, isBoardMember: false }
        });

        const formData = csvForm([
            ['First Name', 'Last Name', 'Email', 'Same Household As'],
            ['Source Member', 'Mergeroll Test', SOURCE_EMAIL, TARGET_EMAIL],
        ]);

        const req = new Request('http://localhost:4000/api/membership-ops/participants/import', {
            method: 'POST',
            body: formData
        }) as unknown as Parameters<typeof POST>[0];
        (req as unknown as { formData: () => Promise<FormData> }).formData = jest.fn().mockResolvedValue(formData);

        const res = await POST(req);
        expect(res.status).toBe(200);

        const data = await res.json();
        // The row failed, but it's surfaced in errors[] — not thrown.
        expect(data.errors).toBeDefined();
        expect(data.errors.join(' ')).toContain('Household linking error');

        // NO partial move: source member still in the source household...
        const source = await prisma.person.findUnique({
            where: { id: sourceMemberId },
            select: { householdId: true }
        });
        expect(source?.householdId).toBe(sourceHouseholdId);
        expect(source?.householdId).not.toBe(targetHouseholdId);

        // ...and the source household still exists.
        const sourceHh = await prisma.household.findUnique({ where: { id: sourceHouseholdId } });
        expect(sourceHh).not.toBeNull();
    });
});
