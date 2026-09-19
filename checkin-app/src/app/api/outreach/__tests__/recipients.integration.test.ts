/**
 * @jest-environment node
 */
/**
 * Integration tests for the recipient snapshot (lib/outreach/recipients.ts) — the
 * presets, the settled/in-flight predicates, suppression, dedup, tombstoning, and
 * the "leads without email" count. Runs against a real Postgres (localhost:5433,
 * INTEGRATION_DB=1) because the whole point is to exercise the real Prisma query
 * shape, not a mocked approximation of it.
 */
import prisma from '@/lib/prisma';
import { computeRecipientSnapshot } from '@/lib/outreach/recipients';

const TAG = 'outreach-recipients-test';
const BOUNDARY = new Date(Date.UTC(2000, 7, 1)); // Aug 1 (year is irrelevant — nextBoundary rolls it forward)
const IN_SEASON_NOW = new Date(Date.UTC(2026, 6, 15)); // Jul 15 — inside the 2-month renewal window before Aug 1
const OFF_SEASON_NOW = new Date(Date.UTC(2026, 0, 15)); // Jan 15 — well outside the window
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

async function makeLead(householdId: number, email: string | null, opts: { emailSuppressed?: boolean; mergedIntoId?: number } = {}) {
    const p = await prisma.person.create({
        data: { name: label(email), email, householdId, isHouseholdLead: true, emailSuppressed: !!opts.emailSuppressed },
    });
    if (opts.mergedIntoId) {
        await prisma.person.update({ where: { id: p.id }, data: { mergedIntoId: opts.mergedIntoId } });
    }
    return p;
}
function label(email: string | null) { return email ?? 'no-email'; }

describe('outreach recipient snapshot', () => {
    let prevBoundary: Date | null = null;

    beforeAll(async () => {
        const existing = await prisma.boardSettings.findUnique({ where: { id: 1 } });
        prevBoundary = existing?.orgMembershipYearBoundary ?? null;
        await wipe();
    });

    afterAll(async () => {
        await wipe();
        await setBoundary(prevBoundary);
        await prisma.$disconnect();
    });

    it('preset (a): non-member is join, unsettled member is renew, both included', async () => {
        await setBoundary(BOUNDARY);
        const nonMemberHh = await makeHousehold('NonMember');
        await makeLead(nonMemberHh.id, `nonmember-${TAG}@example.com`);

        const memberHh = await makeHousehold('UnsettledMember');
        await prisma.orgMembership.create({ data: { householdId: memberHh.id, status: 'ACTIVE' } });
        await makeLead(memberHh.id, `unsettled-${TAG}@example.com`);

        const snap = await computeRecipientSnapshot('a', IN_SEASON_NOW);
        const nonMemberItem = snap.items.find((i) => i.email === `nonmember-${TAG}@example.com`);
        const memberItem = snap.items.find((i) => i.email === `unsettled-${TAG}@example.com`);
        expect(nonMemberItem?.variant).toBe('join');
        expect(nonMemberItem?.status).toBe('queued');
        expect(memberItem?.variant).toBe('renew');
        expect(memberItem?.status).toBe('queued');
    });

    it('preset (a) excludes a settled member in season AND after the boundary; a member settled only for the prior year is renew', async () => {
        await setBoundary(BOUNDARY);
        const hh = await makeHousehold('Settled');
        const membership = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'ACTIVE' } });
        const email = `settled-${TAG}@example.com`;
        await makeLead(hh.id, email);
        // A terminal ACTIVE RENEWAL stamped inside the in-season window — "settled for the coming cycle".
        await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: membership.id, kind: 'RENEWAL', status: 'ACTIVE', stageEnteredAt: IN_SEASON_NOW },
        });

        const inSeason = await computeRecipientSnapshot('a', IN_SEASON_NOW);
        expect(inSeason.items.find((i) => i.email === email)).toBeUndefined();

        // The year they bought is now the live one: still settled, still left alone.
        const pastBoundary = await computeRecipientSnapshot('a', PAST_BOUNDARY_NOW);
        expect(pastBoundary.items.find((i) => i.email === email)).toBeUndefined();

        // Off season, a household whose last settlement was for the PRIOR year is due.
        const staleHh = await makeHousehold('SettledPriorYear');
        const staleMembership = await prisma.orgMembership.create({ data: { householdId: staleHh.id, status: 'ACTIVE' } });
        const staleEmail = `settled-prior-${TAG}@example.com`;
        await makeLead(staleHh.id, staleEmail);
        await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: staleMembership.id, kind: 'RENEWAL', status: 'ACTIVE', stageEnteredAt: new Date(Date.UTC(2024, 6, 15)) },
        });
        const offSeason = await computeRecipientSnapshot('a', OFF_SEASON_NOW);
        expect(offSeason.items.find((i) => i.email === staleEmail)?.variant).toBe('renew');
    });

    it('preset (b) additionally excludes in-flight RENEWAL and in-flight INITIAL households; preset (a) still includes them', async () => {
        await setBoundary(BOUNDARY);

        const renewingHh = await makeHousehold('InFlightRenewal');
        const membership = await prisma.orgMembership.create({ data: { householdId: renewingHh.id, status: 'ACTIVE' } });
        const renewingEmail = `inflight-renewal-${TAG}@example.com`;
        await makeLead(renewingHh.id, renewingEmail);
        await prisma.orgMembershipProcess.create({ data: { orgMembershipId: membership.id, kind: 'RENEWAL', status: 'PENDING_RENEWAL' } });

        const applyingHh = await makeHousehold('InFlightInitial');
        const applyingMembership = await prisma.orgMembership.create({ data: { householdId: applyingHh.id, status: 'NONE' } });
        const applyingEmail = `inflight-initial-${TAG}@example.com`;
        await makeLead(applyingHh.id, applyingEmail);
        await prisma.orgMembershipProcess.create({ data: { orgMembershipId: applyingMembership.id, kind: 'INITIAL', status: 'INTAKE' } });

        const a = await computeRecipientSnapshot('a', IN_SEASON_NOW);
        expect(a.items.find((i) => i.email === renewingEmail)).toBeDefined();
        expect(a.items.find((i) => i.email === applyingEmail)).toBeDefined();

        const b = await computeRecipientSnapshot('b', IN_SEASON_NOW);
        expect(b.items.find((i) => i.email === renewingEmail)).toBeUndefined();
        expect(b.items.find((i) => i.email === applyingEmail)).toBeUndefined();
    });

    it('preset (c) is everyone — no settled/in-flight filtering', async () => {
        await setBoundary(BOUNDARY);
        const hh = await makeHousehold('SettledForC');
        const membership = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'ACTIVE' } });
        const email = `settled-c-${TAG}@example.com`;
        await makeLead(hh.id, email);
        await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: membership.id, kind: 'RENEWAL', status: 'ACTIVE', stageEnteredAt: IN_SEASON_NOW },
        });

        const c = await computeRecipientSnapshot('c', IN_SEASON_NOW);
        expect(c.items.find((i) => i.email === email)).toBeDefined();
    });

    it('suppressed JOIN lead is recorded skipped_unsubscribed; suppressed RENEW lead is still queued', async () => {
        await setBoundary(BOUNDARY);

        const nonMemberHh = await makeHousehold('SuppressedJoin');
        const joinEmail = `suppressed-join-${TAG}@example.com`;
        await makeLead(nonMemberHh.id, joinEmail, { emailSuppressed: true });

        const memberHh = await makeHousehold('SuppressedRenew');
        await prisma.orgMembership.create({ data: { householdId: memberHh.id, status: 'ACTIVE' } });
        const renewEmail = `suppressed-renew-${TAG}@example.com`;
        await makeLead(memberHh.id, renewEmail, { emailSuppressed: true });

        const snap = await computeRecipientSnapshot('a', IN_SEASON_NOW);
        const joinItem = snap.items.find((i) => i.email === joinEmail);
        const renewItem = snap.items.find((i) => i.email === renewEmail);
        expect(joinItem?.variant).toBe('join');
        expect(joinItem?.status).toBe('skipped_unsubscribed');
        expect(renewItem?.variant).toBe('renew');
        expect(renewItem?.status).toBe('queued'); // renew is never suppressed
    });

    it('excludes a tombstoned (merged-away) lead', async () => {
        await setBoundary(BOUNDARY);
        const survivorHh = await makeHousehold('MergeSurvivor');
        const survivor = await makeLead(survivorHh.id, `survivor-${TAG}@example.com`);

        const tombstonedHh = await makeHousehold('MergeTombstone');
        const tombstonedEmail = `tombstoned-${TAG}@example.com`;
        await makeLead(tombstonedHh.id, tombstonedEmail, { mergedIntoId: survivor.id });

        const snap = await computeRecipientSnapshot('a', IN_SEASON_NOW);
        expect(snap.items.find((i) => i.email === tombstonedEmail)).toBeUndefined();
    });

    // No standalone "two leads share an email" case: Person.email is @unique at the DB
    // level AND auto-lowercased at write (lib/prismaEmailNormalize.ts) — two distinct
    // Person rows literally cannot carry the same lowercased email, so this scenario
    // can't be constructed against the real schema (resolveHouseholdRecipients's
    // identical dedupe, emailRecipients.ts:31-38, is untested for the same reason). The
    // dedup in recipients.ts stays as defense-in-depth matching that precedent.

    it('counts a lead without an email in leadsWithoutEmail, and gives them no item', async () => {
        await setBoundary(BOUNDARY);
        const hh = await makeHousehold('NoEmailLead');
        await makeLead(hh.id, null);

        const before = await computeRecipientSnapshot('a', IN_SEASON_NOW);
        // Add one more no-email lead and confirm the count increments by exactly one —
        // avoids a brittle absolute-count assertion (other suites' fixtures may exist).
        const hh2 = await makeHousehold('NoEmailLead2');
        await makeLead(hh2.id, null);
        const after = await computeRecipientSnapshot('a', IN_SEASON_NOW);
        expect(after.leadsWithoutEmail).toBe(before.leadsWithoutEmail + 1);
        expect(after.items.some((i) => i.email === undefined as never)).toBe(false);
    });
});
