/**
 * @jest-environment node
 */
/**
 * Integration tests for board membership settings + volunteer designations.
 */

import { GET as SETTINGS_GET, PUT as SETTINGS_PUT } from '@/app/api/settings/membership/route';
import { GET as DESIG_GET, POST as DESIG_POST, DELETE as DESIG_DELETE } from '@/app/api/settings/membership/volunteer-designations/route';
import prisma from '@/lib/prisma';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';
import { variantSlotYears } from '@/lib/programYear';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const TAG = 'settings-test';

function asBoard(id: number) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id, isSysadmin: false, isBoardMember: true } });
}
function asUser(id: number) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id, isSysadmin: false, isBoardMember: false } });
}
function jsonReq(method: string, body?: unknown, url = 'http://localhost:4000/x') {
    return new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) }) as never;
}

describe('Membership settings + volunteer designations API', () => {
    let boardId: number, plainId: number;
    let restoreBoardSettings: () => Promise<void> = async () => {};

    async function wipe() {
        await prisma.volunteerDesignation.deleteMany({ where: { email: { contains: TAG } } });
        const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const ids = hhs.map((h) => h.id);
        if (ids.length) {
            await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.household.deleteMany({ where: { id: { in: ids } } });
        }
        await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
    }

    beforeAll(async () => {
        restoreBoardSettings = await snapshotBoardSettings();
        await wipe();

        boardId = (await prisma.person.create({ data: { email: `board-${TAG}@example.com`, name: 'Board', isBoardMember: true, household: { create: { name: `Board HH ${TAG}` } } } })).id;
        plainId = (await prisma.person.create({ data: { email: `plain-${TAG}@example.com`, name: 'Plain', household: { create: { name: `Plain HH ${TAG}` } } } })).id;

        // A full-price active member who has signed in, for the designation confirm flow.
        const fullMember = await prisma.person.create({
            data: { email: `fullmember-${TAG}@example.com`, name: 'Full', household: { create: { name: `Full HH ${TAG}`, orgMembership: { create: { status: 'ACTIVE', isVolunteerFamily: false } } } } },
        });
        await prisma.account.create({ data: { userId: fullMember.id, type: 'oauth', provider: 'google', providerAccountId: `${TAG}-${fullMember.id}` } });
        // A member of another household who has never signed in, holding an address before the Board designates it.
        await prisma.person.create({
            data: { email: `preclaimed-${TAG}@example.com`, name: 'Preclaim', household: { create: { name: `Preclaim HH ${TAG}`, orgMembership: { create: { status: 'ACTIVE', isVolunteerFamily: false } } } } },
        });
    });

    afterAll(async () => {
        await wipe();
        await restoreBoardSettings();
        await prisma.$disconnect();
    });

    it('non-board cannot read settings', async () => {
        asUser(plainId);
        const res = await SETTINGS_GET(jsonReq('GET'));
        expect(res.status).toBe(403);
    });

    it('board can read and update settings', async () => {
        asBoard(boardId);
        const getRes = await SETTINGS_GET(jsonReq('GET'));
        expect(getRes.status).toBe(200);

        const putRes = await SETTINGS_PUT(jsonReq('PUT', { perYearVariantClient: true, standardMembershipFeeCents: 12000, volunteerMembershipFeeCents: 3000 }));
        expect(putRes.status).toBe(200);
        const { settings } = await putRes.json();
        expect(settings.standardMembershipFeeCents).toBe(12000);
        expect(settings.volunteerMembershipFeeCents).toBe(3000);
    });

    it('saves and clears the membership product URL', async () => {
        asBoard(boardId);
        const url = 'https://test-store.myshopify.com/products/annual-membership';
        const putRes = await SETTINGS_PUT(jsonReq('PUT', { perYearVariantClient: true, orgMembershipProductUrl: `  ${url}  ` }));
        expect(putRes.status).toBe(200);
        expect((await putRes.json()).settings.orgMembershipProductUrl).toBe(url); // trimmed

        const cleared = await SETTINGS_PUT(jsonReq('PUT', { perYearVariantClient: true, orgMembershipProductUrl: null }));
        expect(cleared.status).toBe(200);
        expect((await cleared.json()).settings.orgMembershipProductUrl).toBeNull();
    });


    it('rejects a negative membership fee and keeps the previous value', async () => {
        asBoard(boardId);
        // Establish a known good value.
        const seed = await SETTINGS_PUT(jsonReq('PUT', { perYearVariantClient: true, standardMembershipFeeCents: 12000 }));
        expect(seed.status).toBe(200);

        // Negative input must be rejected, not clamped to zero.
        const res = await SETTINGS_PUT(jsonReq('PUT', { perYearVariantClient: true, standardMembershipFeeCents: -50 }));
        expect(res.status).toBe(400);

        // Old value survives untouched.
        const getRes = await SETTINGS_GET(jsonReq('GET'));
        const { settings } = await getRes.json();
        expect(settings.BoardSettings.standardMembershipFeeCents).toBe(12000);
    });

    it('refuses a save with no client marker and changes nothing', async () => {
        asBoard(boardId);
        await SETTINGS_PUT(jsonReq('PUT', { perYearVariantClient: true, standardMembershipFeeCents: 12000 }));
        const res = await SETTINGS_PUT(jsonReq('PUT', { standardMembershipFeeCents: 0, orgMembershipYearBoundary: null, orgMembershipVariantId: null }));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/reload/i);
        const stored = await prisma.boardSettings.findUniqueOrThrow({ where: { id: 1 } });
        expect(stored.standardMembershipFeeCents).toBe(12000);
    });

    it('upserts a year variant by year, returns it to the board, and refuses a variant another year holds', async () => {
        asBoard(boardId);
        await prisma.membershipYearVariant.deleteMany({});
        await SETTINGS_PUT(jsonReq('PUT', { perYearVariantClient: true, orgMembershipYearBoundary: '2000-09-01' }));
        const [inProgress, coming] = variantSlotYears(new Date('2000-09-01'), new Date());
        const save = (membershipYear: number, shopifyVariantId: string) =>
            SETTINGS_PUT(jsonReq('PUT', { perYearVariantClient: true, membershipYearVariants: [{ membershipYear, shopifyVariantId, productUrl: null }] }));

        expect((await save(inProgress, '1001')).status).toBe(200);
        expect((await save(inProgress, '1002')).status).toBe(200);
        expect((await save(coming, '1002')).status).toBe(409);
        expect((await save(coming + 1, '1003')).status).toBe(400);
        expect((await save(coming, 'abc')).status).toBe(400);

        const { settings } = await (await SETTINGS_GET(jsonReq('GET'))).json();
        expect(settings.MembershipYearVariant).toEqual([{ membershipYear: inProgress, shopifyVariantId: '1002', productUrl: null }]);
        await prisma.membershipYearVariant.deleteMany({});
    });

    it('accepts a positive scholarshipDenialGraceDays and clears it back to null', async () => {
        asBoard(boardId);
        const res = await SETTINGS_PUT(jsonReq('PUT', { perYearVariantClient: true, scholarshipDenialGraceDays: 14 }));
        expect(res.status).toBe(200);
        expect((await res.json()).settings.scholarshipDenialGraceDays).toBe(14);

        const cleared = await SETTINGS_PUT(jsonReq('PUT', { perYearVariantClient: true, scholarshipDenialGraceDays: null }));
        expect(cleared.status).toBe(200);
        expect((await cleared.json()).settings.scholarshipDenialGraceDays).toBeNull();
    });

    it('rejects a non-positive or fractional scholarshipDenialGraceDays', async () => {
        asBoard(boardId);
        for (const bad of [0, -1, 1.5]) {
            const res = await SETTINGS_PUT(jsonReq('PUT', { perYearVariantClient: true, scholarshipDenialGraceDays: bad }));
            expect(res.status).toBe(400);
        }
    });

    it('board releases a library, audit-logs the delta, and clears it again', async () => {
        asBoard(boardId);
        const release = (library: string, released: boolean) =>
            SETTINGS_PUT(jsonReq('PUT', { perYearVariantClient: true, releaseLibrary: { library, released } }));
        await prisma.boardSettings.upsert({ where: { id: 1 }, create: { id: 1, releasedLibraries: [] }, update: { releasedLibraries: [] } });

        expect((await release('catalog', true)).status).toBe(200);
        expect((await release('catalog', true)).status).toBe(200);
        const res = await release('expense', true);
        expect((await res.json()).settings.releasedLibraries).toEqual(['catalog', 'expense']);
        const log = await prisma.auditLog.findFirst({ where: { actorId: boardId, tableName: 'BoardSettings' }, orderBy: { id: 'desc' } });
        expect(log?.newData).toEqual({ releaseLibrary: { library: 'expense', released: true } });

        await release('catalog', false);
        const cleared = await release('expense', false);
        expect((await cleared.json()).settings.releasedLibraries).toEqual([]);
    });

    it('rejects a full-list write, unknown library keys, and non-board release attempts', async () => {
        asBoard(boardId);
        expect((await SETTINGS_PUT(jsonReq('PUT', { perYearVariantClient: true, releasedLibraries: ['catalog'] }))).status).toBe(400);
        expect((await SETTINGS_PUT(jsonReq('PUT', { perYearVariantClient: true, releaseLibrary: { library: 'nope', released: true } }))).status).toBe(400);
        expect((await SETTINGS_PUT(jsonReq('PUT', { perYearVariantClient: true, releaseLibrary: { library: 'catalog', released: 'yes' } }))).status).toBe(400);
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isSysadmin: true, isBoardMember: false } });
        expect((await SETTINGS_PUT(jsonReq('PUT', { perYearVariantClient: true, releaseLibrary: { library: 'catalog', released: true } }))).status).toBe(403);
    });

    it('adds, lists, and removes a volunteer designation', async () => {
        asBoard(boardId);
        const addRes = await DESIG_POST(jsonReq('POST', { email: `vol-${TAG}@example.com` }));
        expect(addRes.status).toBe(201);
        const { designation } = await addRes.json();
        expect(designation.email).toBe(`vol-${TAG}@example.com`);

        const listRes = await DESIG_GET(jsonReq('GET'));
        const { designations } = await listRes.json();
        expect(designations.some((d: { email: string }) => d.email === `vol-${TAG}@example.com`)).toBe(true);

        const delRes = await DESIG_DELETE(jsonReq('DELETE', undefined, `http://localhost:4000/x?id=${designation.id}`));
        expect(delRes.status).toBe(200);
        const after = await prisma.volunteerDesignation.findUnique({ where: { id: designation.id } });
        expect(after).toBeNull();
    });

    it("shows an existing member's household and sets isVolunteerFamily only on confirm", async () => {
        asBoard(boardId);
        const email = `fullmember-${TAG}@example.com`;
        const household = await prisma.household.findFirstOrThrow({ where: { name: `Full HH ${TAG}` }, include: { orgMembership: true } });

        const preview = await DESIG_POST(jsonReq('POST', { email }));
        expect(preview.status).toBe(200);
        expect(await preview.json()).toMatchObject({ requiresConfirmation: true, match: { householdId: household.id, householdName: `Full HH ${TAG}` } });
        expect((await prisma.orgMembership.findUniqueOrThrow({ where: { id: household.orgMembership!.id } })).isVolunteerFamily).toBe(false);

        const confirm = await DESIG_POST(jsonReq('POST', { email, confirmHouseholdId: household.id }));
        expect(confirm.status).toBe(200);
        expect((await prisma.orgMembership.findUniqueOrThrow({ where: { id: household.orgMembership!.id } })).isVolunteerFamily).toBe(true);
        const audit = await prisma.auditLog.findFirst({ where: { tableName: 'OrgMembership', affectedEntityId: household.orgMembership!.id, actorId: boardId } });
        expect(audit?.newData).toEqual({ isVolunteerFamily: true });
        expect(await prisma.volunteerDesignation.count({ where: { email } })).toBe(0);
    });

    it('stores, rather than confirms, an address held only by someone who never signed in, and lists that holder', async () => {
        asBoard(boardId);
        const email = `preclaimed-${TAG}@example.com`;
        const household = await prisma.household.findFirstOrThrow({ where: { name: `Preclaim HH ${TAG}` }, include: { orgMembership: true } });

        const res = await DESIG_POST(jsonReq('POST', { email }));
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.requiresConfirmation).toBeUndefined();
        expect(body.matches).toEqual([expect.objectContaining({ householdId: household.id, signInVerified: false, hasMembership: true })]);
        expect((await prisma.orgMembership.findUniqueOrThrow({ where: { id: household.orgMembership!.id } })).isVolunteerFamily).toBe(false);
    });

    it('treats inbox variants of a designated email as already designated', async () => {
        asBoard(boardId);
        const base = `voldedupe-${TAG}@gmail.com`;
        const first = await DESIG_POST(jsonReq('POST', { email: base }));
        expect(first.status).toBe(201);
        const { designation } = await first.json();

        for (const variant of [`voldedupe-${TAG}+treehouse@gmail.com`, `vol.dedupe-${TAG}@googlemail.com`, ` VolDedupe-${TAG}@gmail.com `]) {
            const res = await DESIG_POST(jsonReq('POST', { email: variant }));
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.warning).toBe('This email is already designated.');
            expect(data.designation.id).toBe(designation.id);
        }

        expect(await prisma.volunteerDesignation.count({ where: { email: { contains: `voldedupe-${TAG}` } } })).toBe(1);
    });

    it('dedupes against a row stored before canonicalization', async () => {
        asBoard(boardId);
        const legacy = await prisma.volunteerDesignation.create({ data: { email: `legacyvol-${TAG}+tag@gmail.com` } });
        const res = await DESIG_POST(jsonReq('POST', { email: `legacy.vol-${TAG}@gmail.com` }));
        expect(res.status).toBe(200);
        expect((await res.json()).designation.id).toBe(legacy.id);
        expect(await prisma.volunteerDesignation.count({ where: { email: { contains: `legacyvol-${TAG}` } } })).toBe(1);
    });

    it('rejects an invalid email', async () => {
        asBoard(boardId);
        const res = await DESIG_POST(jsonReq('POST', { email: 'not-an-email' }));
        expect(res.status).toBe(400);
    });

    it('non-board cannot manage designations', async () => {
        asUser(plainId);
        const res = await DESIG_POST(jsonReq('POST', { email: `x-${TAG}@example.com` }));
        expect(res.status).toBe(403);
    });
});
