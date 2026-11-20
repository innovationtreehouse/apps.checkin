/**
 * @jest-environment node
 */
/**
 * Integration tests for the recipient snapshot (lib/outreach/recipients.ts) — each email
 * type's member-only audience, the reminder's renewed-household skip, archived and denied
 * households, and the "leads without email" count. Runs against a real Postgres (localhost:5433,
 * INTEGRATION_DB=1) because the whole point is to exercise the real Prisma query
 * shape, not a mocked approximation of it.
 */
import prisma from '@/lib/prisma';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';
import { computeRecipientSnapshot } from '@/lib/outreach/recipients';

const TAG = 'outreach-recipients-test';
const BOUNDARY = new Date(Date.UTC(2000, 7, 1)); // Aug 1 (year is irrelevant — nextBoundary rolls it forward)
const IN_SEASON_NOW = new Date(Date.UTC(2026, 6, 15)); // Jul 15 — inside the 2-month renewal window before Aug 1
const PAST_BOUNDARY_NOW = new Date(Date.UTC(2026, 8, 15)); // Sep 15 — six weeks past the Aug 1 boundary

async function setBoundary(date: Date | null) {
    await prisma.boardSettings.upsert({
        where: { id: 1 },
        create: { id: 1, standardMembershipFeeCents: 0, volunteerMembershipFeeCents: 0, orgMembershipYearBoundary: date },
        update: { orgMembershipYearBoundary: date },
    });
}

async function wipe() {
    const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const ids = hhs.map((h) => h.id);
    if (ids.length) {
        await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: ids } } } });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: ids } } });
    }
}

async function makeHousehold(label: string) {
    return prisma.household.create({ data: { name: `${label} ${TAG}` } });
}

async function makeLead(householdId: number, email: string | null) {
    return prisma.person.create({
        data: { name: email ?? 'no-email', email, householdId, isHouseholdLead: true },
    });
}

/** A household whose membership is ACTIVE, with one lead; returns the membership id. */
async function makeMember(label: string, email: string | null) {
    const hh = await makeHousehold(label);
    const membership = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'ACTIVE' } });
    await makeLead(hh.id, email);
    return membership.id;
}

const emails = (snap: { items: { email: string }[] }) => snap.items.map((i) => i.email);

describe('outreach recipient snapshot', () => {
    let restoreBoardSettings: () => Promise<void> = async () => {};

    beforeAll(async () => {
        restoreBoardSettings = await snapshotBoardSettings();
        await wipe();
    });

    afterAll(async () => {
        await wipe();
        await restoreBoardSettings();
        await prisma.$disconnect();
    });

    it('never includes a non-member household lead, for either email type', async () => {
        await setBoundary(BOUNDARY);
        const none = await makeHousehold('NonMember');
        await makeLead(none.id, `nonmember-${TAG}@example.com`);
        const revoked = await makeHousehold('Revoked');
        await prisma.orgMembership.create({ data: { householdId: revoked.id, status: 'REVOKED' } });
        await makeLead(revoked.id, `revoked-${TAG}@example.com`);
        const applying = await makeHousehold('Applying');
        const applyingMembership = await prisma.orgMembership.create({ data: { householdId: applying.id, status: 'NONE' } });
        await makeLead(applying.id, `applying-${TAG}@example.com`);
        await prisma.orgMembershipProcess.create({ data: { orgMembershipId: applyingMembership.id, kind: 'INITIAL', status: 'INTAKE' } });

        for (const type of ['opening', 'reminder'] as const) {
            const got = emails(await computeRecipientSnapshot(type, IN_SEASON_NOW));
            expect(got).not.toContain(`nonmember-${TAG}@example.com`);
            expect(got).not.toContain(`revoked-${TAG}@example.com`);
            expect(got).not.toContain(`applying-${TAG}@example.com`);
        }
    });

    it("skips a household that said it won't renew into the noted year, for both email types", async () => {
        await setBoundary(BOUNDARY);
        const notedId = await makeMember('Noted', `noted-${TAG}@example.com`);
        await prisma.orgMembership.update({ where: { id: notedId }, data: { notRenewingYear: 2026 } });
        const staleId = await makeMember('StaleNote', `stale-note-${TAG}@example.com`);
        await prisma.orgMembership.update({ where: { id: staleId }, data: { notRenewingYear: 2025 } });

        for (const type of ['opening', 'reminder'] as const) {
            const got = emails(await computeRecipientSnapshot(type, IN_SEASON_NOW));
            expect(got).not.toContain(`noted-${TAG}@example.com`);
            expect(got).toContain(`stale-note-${TAG}@example.com`);
        }
    });

    it("before the window, skips a note for the next year, the one the email is about, and not one for the live year", async () => {
        await setBoundary(BOUNDARY);
        const nextId = await makeMember('NotedNext', `noted-next-${TAG}@example.com`);
        await prisma.orgMembership.update({ where: { id: nextId }, data: { notRenewingYear: 2027 } });
        const liveId = await makeMember('NotedLive', `noted-live-${TAG}@example.com`);
        await prisma.orgMembership.update({ where: { id: liveId }, data: { notRenewingYear: 2026 } });

        for (const type of ['opening', 'reminder'] as const) {
            const got = emails(await computeRecipientSnapshot(type, PAST_BOUNDARY_NOW));
            expect(got).not.toContain(`noted-next-${TAG}@example.com`);
            expect(got).toContain(`noted-live-${TAG}@example.com`);
        }
    });

    it('opening goes to every member-household lead, renewed or not; a non-lead member gets nothing', async () => {
        await setBoundary(BOUNDARY);
        await makeMember('OpenUnrenewed', `open-unrenewed-${TAG}@example.com`);
        const renewedId = await makeMember('OpenRenewed', `open-renewed-${TAG}@example.com`);
        await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: renewedId, kind: 'RENEWAL', status: 'ACTIVE', stageEnteredAt: IN_SEASON_NOW, appliesToYear: 2026 },
        });
        const hh = await prisma.orgMembership.findUniqueOrThrow({ where: { id: renewedId } });
        await prisma.person.create({ data: { name: 'Second adult', email: `open-nonlead-${TAG}@example.com`, householdId: hh.householdId, isHouseholdLead: false } });

        const got = emails(await computeRecipientSnapshot('opening', IN_SEASON_NOW));
        expect(got).toContain(`open-unrenewed-${TAG}@example.com`);
        expect(got).toContain(`open-renewed-${TAG}@example.com`);
        expect(got).not.toContain(`open-nonlead-${TAG}@example.com`);
    });

    it('reminder skips a household that completed renewal for the year the email is about', async () => {
        await setBoundary(BOUNDARY);
        const id = await makeMember('Renewed', `renewed-${TAG}@example.com`);
        await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: id, kind: 'RENEWAL', status: 'ACTIVE', stageEnteredAt: IN_SEASON_NOW, appliesToYear: 2026 },
        });
        const joinedId = await makeMember('JoinedInWindow', `joined-${TAG}@example.com`);
        await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: joinedId, kind: 'INITIAL', status: 'ACTIVE', stageEnteredAt: IN_SEASON_NOW, appliesToYear: 2026 },
        });

        const inSeason = emails(await computeRecipientSnapshot('reminder', IN_SEASON_NOW));
        expect(inSeason).not.toContain(`renewed-${TAG}@example.com`);
        expect(inSeason).not.toContain(`joined-${TAG}@example.com`);

        // After the boundary the email is about 2027, which neither has renewed for.
        const nextId = await makeMember('RenewedNext', `renewed-next-${TAG}@example.com`);
        await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: nextId, kind: 'RENEWAL', status: 'ACTIVE', stageEnteredAt: PAST_BOUNDARY_NOW, appliesToYear: 2027 },
        });
        const pastBoundary = emails(await computeRecipientSnapshot('reminder', PAST_BOUNDARY_NOW));
        expect(pastBoundary).toContain(`renewed-${TAG}@example.com`);
        expect(pastBoundary).not.toContain(`renewed-next-${TAG}@example.com`);
    });

    it('reminder still goes to a household whose renewal is in progress, or settled only for the prior year', async () => {
        await setBoundary(BOUNDARY);
        const openedId = await makeMember('RenewalOpened', `renewal-opened-${TAG}@example.com`);
        await prisma.orgMembershipProcess.create({ data: { orgMembershipId: openedId, kind: 'RENEWAL', status: 'PENDING_RENEWAL' } });
        // Paid, waiting on the background check: renewal has not completed.
        const paidId = await makeMember('RenewalPaid', `renewal-paid-${TAG}@example.com`);
        await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: paidId, kind: 'RENEWAL', status: 'PENDING_BG_CLEARANCE', paidAt: IN_SEASON_NOW, appliesToYear: 2026 },
        });
        const priorId = await makeMember('SettledPriorYear', `settled-prior-${TAG}@example.com`);
        await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: priorId, kind: 'RENEWAL', status: 'ACTIVE', stageEnteredAt: new Date(Date.UTC(2025, 6, 15)), appliesToYear: 2025 },
        });

        const got = emails(await computeRecipientSnapshot('reminder', IN_SEASON_NOW));
        expect(got).toContain(`renewal-opened-${TAG}@example.com`);
        expect(got).toContain(`renewal-paid-${TAG}@example.com`);
        expect(got).toContain(`settled-prior-${TAG}@example.com`);
    });

    it('leaves out denied and archived households', async () => {
        await setBoundary(BOUNDARY);
        const denied = await makeHousehold('Denied');
        await prisma.orgMembership.create({ data: { householdId: denied.id, status: 'DENIED' } });
        await makeLead(denied.id, `denied-${TAG}@example.com`);
        const archivedId = await makeMember('Archived', `archived-${TAG}@example.com`);
        const archived = await prisma.orgMembership.findUniqueOrThrow({ where: { id: archivedId } });
        await prisma.household.update({ where: { id: archived.householdId }, data: { archivedAt: IN_SEASON_NOW } });

        for (const type of ['opening', 'reminder'] as const) {
            const got = emails(await computeRecipientSnapshot(type, IN_SEASON_NOW));
            expect(got).not.toContain(`denied-${TAG}@example.com`);
            expect(got).not.toContain(`archived-${TAG}@example.com`);
        }
    });

    it('counts a member lead without an email in leadsWithoutEmail, and not a non-member one', async () => {
        await setBoundary(BOUNDARY);
        // Relative counts: other suites' fixtures may share the database.
        const before = await computeRecipientSnapshot('opening', IN_SEASON_NOW);
        await makeMember('NoEmailMember', null);
        const nonMember = await makeHousehold('NoEmailNonMember');
        await makeLead(nonMember.id, null);
        const after = await computeRecipientSnapshot('opening', IN_SEASON_NOW);
        expect(after.leadsWithoutEmail).toBe(before.leadsWithoutEmail + 1);
        expect(after.items).toHaveLength(before.items.length);
    });
});
