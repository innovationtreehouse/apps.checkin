/**
 * @jest-environment node
 */
/**
 * Preview-vs-commit consistency. The preview endpoint and the commit endpoint
 * each independently re-implement column detection, DOB parsing, duplicate
 * detection, and "Same Household As" resolution. They can silently drift —
 * the admin approves what preview shows, then commit does something else.
 *
 * These tests run BOTH endpoints on the SAME CSV (Excel-serial DOB + duplicate
 * email + household reference) and pin preview's reported per-row outcome to
 * what commit actually persists.
 *
 * Excel-serial DOB: both endpoints now share parseImportDob() (src/lib/importDob.ts),
 * so the serial "33239" parses to 1991-01-01 (an adult) on BOTH sides. Previously
 * preview did a bare `new Date("33239")` -> YEAR 33239 (far-future) and flagged the
 * same person as a youth while commit imported an adult lead. The second test pins
 * that they agree; if the two parsers ever diverge again it goes red.
 */

import { POST as COMMIT } from '@/app/api/membership-ops/participants/import/route';
import { POST as PREVIEW } from '@/app/api/membership-ops/participants/import/preview/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import * as xlsx from 'xlsx';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

const ANCHOR_EMAIL = 'anchor-consist-import-test@example.com';
const REF_EMAIL = 'ref-consist-import-test@example.com';
// Excel serial date (days since 1899-12-30). ~33239 -> 1991, an adult DOB.
const DOB_SERIAL = 33239;

interface RowPreview {
    rowNumber: number;
    status: string;
    action: string;
    warnings: string[];
}

describe('Bulk import: preview vs commit consistency', () => {
    let testAdminId: number;

    const cleanup = async () => {
        try {
            await prisma.orgMembership.deleteMany({});
            await prisma.person.deleteMany({ where: { email: { contains: 'consist-import-test' } } });
            await prisma.person.deleteMany({ where: { name: { contains: 'Consist Import Test' } } });
            await prisma.household.deleteMany({ where: { householdMembers: { none: {} } } });
        } catch {}
    };

    // The actor's email/name sit outside cleanup's patterns: cleanup runs after every
    // test, and an actor that no longer exists is refused by the route.
    const ACTOR_EMAIL = 'admin-consist-actor@example.com';
    const removeActor = () => prisma.person.deleteMany({ where: { email: ACTOR_EMAIL } });

    beforeAll(async () => {
        await removeActor();
        await cleanup();
        const admin = await prisma.person.create({
            data: { email: ACTOR_EMAIL, name: 'Admin Consist Actor', isSysadmin: true, household: { create: { name: "Test HH" } } }
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

    // The one CSV both endpoints chew on:
    //   data row 1 (Row 2): Anchor, new email, Excel-serial DOB
    //   data row 2 (Row 3): Dupe, SAME email as Anchor (intra-sheet duplicate)
    //   data row 3 (Row 4): Ref, new email, "Same Household As" -> Anchor's email
    const SHEET: (string | number)[][] = [
        ['First Name', 'Last Name', 'Email', 'DOB', 'Same Household As'],
        ['Anchor', 'Consist Import Test', ANCHOR_EMAIL, DOB_SERIAL, ''],
        ['Dupe', 'Consist Import Test', ANCHOR_EMAIL, '', ''],
        ['Ref', 'Consist Import Test', REF_EMAIL, '', ANCHOR_EMAIL],
    ];

    const csvForm = () => {
        const ws = xlsx.utils.aoa_to_sheet(SHEET);
        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'csv' });
        const fd = new FormData();
        fd.append('file', new Blob([buffer], { type: 'text/csv' }), 'import.csv');
        return fd;
    };

    const call = async (handler: typeof COMMIT | typeof PREVIEW) => {
        const fd = csvForm();
        const req = new Request('http://localhost:4000/x', { method: 'POST', body: fd }) as unknown as Parameters<typeof COMMIT>[0];
        (req as unknown as { formData: () => Promise<FormData> }).formData = jest.fn().mockResolvedValue(fd);
        const res = await handler(req);
        return { res, body: await res.json() };
    };

    const runPreview = async (): Promise<RowPreview[]> => {
        const { res, body } = await call(PREVIEW);
        expect(res.status).toBe(200);
        return body.rows as RowPreview[];
    };

    it('duplicate-email detection and household resolution match what commit persists', async () => {
        const preview = await runPreview();

        // --- PREVIEW SIDE ---
        // Row 3 (Dupe) shares Row 2's (Anchor) email -> preview flags the duplicate.
        const dupePreview = preview.find(r => r.rowNumber === 3)!;
        expect(dupePreview.warnings.some(w => /duplicate email/i.test(w))).toBe(true);

        // Row 4 (Ref) references Anchor's household via the batch -> preview says it will link.
        const refPreview = preview.find(r => r.rowNumber === 4)!;
        expect(refPreview.action.toLowerCase()).toContain('link to household');

        // --- COMMIT SIDE (same CSV) ---
        const { res, body } = await call(COMMIT);
        expect(res.status).toBe(200);
        expect(body.success).toBe(true);

        // Dup detection: commit collapses the two Anchor-email rows into ONE participant
        // (the second row updates the first), matching preview's "duplicate" signal.
        const anchorRecords = await prisma.person.findMany({ where: { email: ANCHOR_EMAIL } });
        expect(anchorRecords).toHaveLength(1);

        // Household resolution: Ref actually lands in Anchor's household, matching preview's "will link".
        const ref = await prisma.person.findUnique({ where: { email: REF_EMAIL }, select: { householdId: true } });
        expect(ref?.householdId).toBe(anchorRecords[0].householdId);
    });

    // Preview and commit must parse the SAME Excel-serial DOB to the SAME date, so
    // they agree on whether Anchor is a youth. (Regression guard: before the shared
    // parseImportDob() helper, preview read "33239" as YEAR 33239 and called Anchor a
    // youth while commit imported a 1991 adult. If they diverge again this goes red.)
    it('preview parses the Excel-serial DOB to the same date/age class as commit', async () => {
        const preview = await runPreview();
        const anchorPreview = preview.find(r => r.rowNumber === 2)!;

        const { body } = await call(COMMIT);
        expect(body.success).toBe(true);

        // Commit's Excel-serial branch parses 33239 -> 1991-01-01 (an ADULT)...
        const anchor = await prisma.person.findUnique({ where: { email: ANCHOR_EMAIL }, select: { id: true, dateOfBirth: true } });
        expect(anchor?.dateOfBirth?.getUTCFullYear()).toBe(1991);
        // ...and commit therefore makes the adult a household lead.
        const lead = await prisma.person.findFirst({ where: { id: anchor!.id, isHouseholdLead: true }, select: { id: true } });
        expect(lead).not.toBeNull();

        // Preview must agree Anchor is an adult: NO "Student (under 18)" warning.
        expect(anchorPreview.warnings.some(w => /student.*under 18/i.test(w))).toBe(false);
    });
});
