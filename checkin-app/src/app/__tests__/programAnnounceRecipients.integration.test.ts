/**
 * @jest-environment node
 */
/**
 * Integration tests for notifyNewProgramAnnounced's recipient set — the #1153
 * covered-member audience (isActiveOrgMemberThrough / #1061 "full duration" rule),
 * independent of the PATCH route's announceOnOpen toggle gate (covered by
 * programAnnounceNotification.integration.test.ts). Calls notifyNewProgramAnnounced
 * directly, skipping the route.
 */

jest.mock('@/lib/email', () => ({
    sendEmail: jest.fn().mockResolvedValue(true),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));

import { notifyNewProgramAnnounced } from '@/lib/notifications';
import { membershipYearCycle } from '@/lib/membership/renewal';
import { sendEmail } from '@/lib/email';
import prisma from '@/lib/prisma';

const mockSendEmail = sendEmail as jest.Mock;
const TAG = 'announce-recip-test';

describe('notifyNewProgramAnnounced recipient set (#1153 covered-member audience)', () => {
    let tombstoneHouseholdId: number, tombstoneTargetId: number;
    // Integration suites share one DB, so BoardSettings row 1 may already carry a
    // boundary from another suite. The unbounded cases below require none.
    let prevBoardSettingsOuter: { orgMembershipYearBoundary: Date | null; bgRecheckMonths: number } | null = null;

    async function wipe() {
        const hhs = await prisma.household.findMany({
            where: { OR: [{ name: { contains: TAG } }, { householdMembers: { some: { email: { contains: TAG } } } }] },
            select: { id: true },
        });
        const ids = hhs.map((h) => h.id);
        if (ids.length) {
            await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: ids } } } });
            await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.household.deleteMany({ where: { id: { in: ids } } });
        }
        await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
    }

    beforeAll(async () => {
        await wipe();

        const existing = await prisma.boardSettings.findUnique({ where: { id: 1 } });
        prevBoardSettingsOuter = existing
            ? { orgMembershipYearBoundary: existing.orgMembershipYearBoundary, bgRecheckMonths: existing.bgRecheckMonths }
            : null;
        await prisma.boardSettings.upsert({
            where: { id: 1 },
            create: { id: 1, orgMembershipYearBoundary: null },
            update: { orgMembershipYearBoundary: null },
        });

        // Covered: ACTIVE-membership household, default prefs -> included.
        await prisma.person.create({
            data: {
                email: `covered-${TAG}@example.com`, name: 'Covered',
                household: { create: { name: `Covered HH ${TAG}`, orgMembership: { create: { status: 'ACTIVE', memberSince: new Date() } } } },
            },
        });

        // Uncovered: no orgMembership at all -> fails ACTIVE_ORG_MEMBER_PERSON_WHERE.
        await prisma.person.create({
            data: { email: `uncovered-${TAG}@example.com`, name: 'Uncovered', household: { create: { name: `Uncovered HH ${TAG}` } } },
        });

        // Opted-out: covered household, but notifyNewPrograms:false.
        await prisma.person.create({
            data: {
                email: `optedout-${TAG}@example.com`, name: 'OptedOut',
                notificationSettings: { notifyNewPrograms: false },
                household: { create: { name: `OptedOut HH ${TAG}`, orgMembership: { create: { status: 'ACTIVE', memberSince: new Date() } } } },
            },
        });

        // Tombstone: covered household, but mergedIntoId set -> excluded by LIVE_PERSON.
        // The live merge target stays covered and included.
        const tombstoneTarget = await prisma.person.create({
            data: {
                email: `tombstone-target-${TAG}@example.com`, name: 'TombstoneTarget',
                household: { create: { name: `Tombstone HH ${TAG}`, orgMembership: { create: { status: 'ACTIVE', memberSince: new Date() } } } },
            },
            select: { id: true, householdId: true },
        });
        tombstoneTargetId = tombstoneTarget.id;
        tombstoneHouseholdId = tombstoneTarget.householdId;
        await prisma.person.create({
            data: { email: `tombstone-${TAG}@example.com`, name: 'Tombstone', householdId: tombstoneHouseholdId, mergedIntoId: tombstoneTargetId },
        });
    });

    afterAll(async () => {
        await wipe();
        if (prevBoardSettingsOuter) {
            await prisma.boardSettings.update({ where: { id: 1 }, data: prevBoardSettingsOuter });
        } else {
            await prisma.boardSettings.delete({ where: { id: 1 } }).catch(() => {});
        }
    });

    beforeEach(() => {
        mockSendEmail.mockClear();
    });

    it('includes covered+opted-in live members, excludes uncovered/opted-out/tombstoned, with no date boundary configured', async () => {
        await notifyNewProgramAnnounced({ name: 'Robotics Recip Test', endAt: new Date('2026-12-01') });

        const recipients = mockSendEmail.mock.calls.map((c) => c[0]);
        expect(recipients).toContain(`covered-${TAG}@example.com`);
        expect(recipients).toContain(`tombstone-target-${TAG}@example.com`);
        expect(recipients).not.toContain(`uncovered-${TAG}@example.com`);
        expect(recipients).not.toContain(`optedout-${TAG}@example.com`);
        expect(recipients).not.toContain(`tombstone-${TAG}@example.com`);
    });

    // #1061 "full duration" gate: a household settled for the live membership year
    // (#1811) is valid only through the boundary that closes it. One boundary config
    // (Aug 1, via BoardSettings row 1, which the outer beforeAll leaves unset)
    // exercises both sides: a program ending after that boundary excludes the
    // household, a program ending before it includes the SAME household.
    describe('expired-at-midyear boundary', () => {
        let prevBoardSettings: { orgMembershipYearBoundary: Date | null; bgRecheckMonths: number } | null = null;
        const AUG1 = new Date(Date.UTC(2020, 7, 1)); // only month/day matter to membershipYearCycle()
        // Both program dates are derived from the boundary the code will actually
        // compute, never hardcoded: a literal date silently swaps the two cases
        // once the real clock passes it.
        const boundary = membershipYearCycle(AUG1, new Date()).cycleEnd;
        const ENDS_AFTER_BOUNDARY = new Date(boundary.getTime() + 30 * 24 * 60 * 60 * 1000);
        const ENDS_BEFORE_BOUNDARY = new Date((Date.now() + boundary.getTime()) / 2);

        beforeAll(async () => {
            const existing = await prisma.boardSettings.findUnique({ where: { id: 1 } });
            prevBoardSettings = existing
                ? { orgMembershipYearBoundary: existing.orgMembershipYearBoundary, bgRecheckMonths: existing.bgRecheckMonths }
                : null;
            await prisma.boardSettings.upsert({
                where: { id: 1 },
                create: { id: 1, orgMembershipYearBoundary: AUG1 },
                update: { orgMembershipYearBoundary: AUG1 },
            });
            // Settle the covered household for the live year (paid now ⇒ on or after
            // settledSince in either season); without a paid process it has bought
            // nothing and reads as lapsed once the boundary passes.
            await prisma.orgMembershipProcess.create({
                data: {
                    kind: 'INITIAL', status: 'ACTIVE', paidAt: new Date(), stageEnteredAt: new Date(),
                    orgMembership: { connect: { householdId: (await prisma.household.findFirstOrThrow({ where: { name: `Covered HH ${TAG}` }, select: { id: true } })).id } },
                },
            });
        });

        afterAll(async () => {
            if (prevBoardSettings) {
                await prisma.boardSettings.update({ where: { id: 1 }, data: prevBoardSettings });
            } else {
                await prisma.boardSettings.delete({ where: { id: 1 } }).catch(() => {});
            }
        });

        it('excludes the covered household when the program ends AFTER the boundary (unrenewed)', async () => {
            await notifyNewProgramAnnounced({ name: 'Robotics Past Boundary', endAt: ENDS_AFTER_BOUNDARY });
            const recipients = mockSendEmail.mock.calls.map((c) => c[0]);
            expect(recipients).not.toContain(`covered-${TAG}@example.com`);
        });

        it('includes the SAME covered household when the program ends BEFORE the boundary', async () => {
            await notifyNewProgramAnnounced({ name: 'Robotics Before Boundary', endAt: ENDS_BEFORE_BOUNDARY });
            const recipients = mockSendEmail.mock.calls.map((c) => c[0]);
            expect(recipients).toContain(`covered-${TAG}@example.com`);
        });
    });
});
