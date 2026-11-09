import prisma from "@/lib/prisma";
import {
    seedBaseline,
    createFamily,
    createProgram,
    createEvent,
    createCheckins,
} from "@/lib/dev/seed-helpers";
import { classify, effectiveOffSaleAt, enrollmentClosedBy } from "@/lib/programs/saleState";
import { membershipYearOf, nextBoundary } from "@/lib/programYear";
import { orgCalendarDay } from "@/lib/time";

/**
 * Integration coverage for the dev seed/macro helpers + the reset truncate-and-reseed flow
 * (docs/ops/dev-instance.md, "Macros" + "Reset"). Opt-in (*.integration.test.ts) — needs a live Postgres and is
 * DESTRUCTIVE (it truncates the public schema), so it is excluded from the default CI run. Run with
 * `npm run test:integration` against a throwaway dev database.
 */

// The same drift-proof truncation the reset action performs, factored here so the test exercises
// the real list-from-catalog behavior rather than a hand-written table list.
async function truncateAll() {
    const rows = await prisma.$queryRaw<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename NOT IN ('_prisma_migrations', 'DevLedger')
    `;
    const tables = rows.map((r) => `"${r.tablename}"`).join(", ");
    if (tables) await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE;`);
}

describe("dev seed-helpers (integration)", () => {
    beforeAll(async () => {
        await truncateAll();
        await seedBaseline(prisma);
    });

    afterAll(async () => {
        // This suite seeds the baseline personas — including a BOARD member — into the
        // DB every integration suite shares. Leaving them behind makes any later suite
        // that reasons about global role counts fail on ambient fixtures, so truncate
        // back to empty rather than just disconnecting.
        await truncateAll();
        // The truncate also wipes the Org row the org_registry migration inserts, which
        // later suites in this worker resolve through getOrg(); restore that baseline.
        await prisma.org.create({ data: { id: "treehouse", name: "Treehouse" } });
        await prisma.$disconnect();
    });

    it("seedBaseline creates the standard personas + sample program", async () => {
        const personas = await prisma.person.count();
        expect(personas).toBeGreaterThanOrEqual(9);
        expect(await prisma.program.count()).toBeGreaterThanOrEqual(1);
        expect(await prisma.person.findUnique({ where: { email: "boardmember@example.com" } })).not.toBeNull();
    });

    it("seeded Board, BG reviewer and Finance holders are Key Volunteers with a signed agreement", async () => {
        for (const email of ["keyholder1@example.com"]) {
            const person = await prisma.person.findUniqueOrThrow({ where: { email }, select: { id: true } });
            expect(await prisma.personRole.count({ where: { personId: person.id, role: "KEY_VOLUNTEER" } })).toBe(0);
        }
        for (const email of ["boardmember@example.com", "bg.reviewer@example.com", "finance@example.com"]) {
            const person = await prisma.person.findUniqueOrThrow({ where: { email }, select: { id: true } });
            expect(await prisma.personRole.findUnique({ where: { personId_role: { personId: person.id, role: "KEY_VOLUNTEER" } } })).not.toBeNull();
            expect(await prisma.orgMembershipProcess.count({
                where: { subjectPersonId: person.id, kind: "KEY_VOLUNTEER_AGREEMENT", status: "ACTIVE" },
            })).toBe(1);
        }
        // Re-seeding opens nothing new.
        await seedBaseline(prisma);
        expect(await prisma.orgMembershipProcess.count({ where: { kind: "KEY_VOLUNTEER_AGREEMENT", status: { not: "ACTIVE" } } })).toBe(0);
    });

    describe("seeded program spread", () => {
        const DAY = 24 * 60 * 60 * 1000;
        const today = orgCalendarDay();
        const byName = (name: string) =>
            prisma.program.findFirstOrThrow({
                where: { name },
                include: { participants: true, events: { include: { visits: true } } },
            });

        it("keeps Woodworking 101 for the flow tests", async () => {
            const program = await byName("Woodworking 101");
            expect(classify(program)).toBe("ON_SALE");
        });

        it.each([
            ["Seed: finished", "FINISHED"],
            ["Seed: running now", "SALE_ENDED"],
            ["Seed: upcoming", "ON_SALE"],
            ["Seed: near off sale", "ON_SALE"],
            ["Seed: off sale", "SALE_ENDED"],
            ["Seed: full", "ON_SALE"],
            ["Seed: next membership year", "ON_SALE"],
            ["Seed: members only", "ON_SALE"],
            ["Seed: ages 12-17", "ON_SALE"],
        ])("%s is in sale state %s with a lead and an event", async (name, state) => {
            const program = await byName(name);
            expect(classify(program)).toBe(state);
            expect(program.leadMentorId).not.toBeNull();
            expect(program.events.length).toBeGreaterThanOrEqual(1);
        });

        it("dates sit where each name says, relative to today", async () => {
            const finished = await byName("Seed: finished");
            expect(finished.endAt.getTime()).toBeLessThan(today.getTime());

            const running = await byName("Seed: running now");
            expect(running.phase).toBe("RUNNING");
            expect(running.startAt.getTime()).toBeLessThan(today.getTime());
            expect(running.endAt.getTime()).toBeGreaterThan(today.getTime());

            const upcoming = await byName("Seed: upcoming");
            expect(upcoming.phase).toBe("UPCOMING");
            expect(upcoming.startAt.getTime()).toBeGreaterThan(today.getTime());

            const nearOffSale = await byName("Seed: near off sale");
            const offSaleIn = effectiveOffSaleAt(nearOffSale).getTime() - today.getTime();
            expect(offSaleIn).toBeGreaterThan(0);
            expect(offSaleIn).toBeLessThanOrEqual(2 * DAY);

            const offSale = await byName("Seed: off sale");
            expect(offSale.phase).toBe("UPCOMING");
            expect(offSale.startAt.getTime()).toBeGreaterThan(today.getTime());
        });

        it("the full program is at capacity, so enrollment reads as full", async () => {
            const full = await byName("Seed: full");
            const active = full.participants.filter((p) => p.status === "ACTIVE").length;
            expect(active).toBe(full.maxParticipants);
            expect(enrollmentClosedBy(full, active)).toBe("FULL");
        });

        it("the next-year program runs in the membership year after this one", async () => {
            const settings = await prisma.boardSettings.findUniqueOrThrow({ where: { id: 1 } });
            const boundary = settings.orgMembershipYearBoundary!;
            const program = await byName("Seed: next membership year");
            expect(program.appliesToYear).toBe(membershipYearOf(boundary, today) + 1);
            expect(program.startAt.getTime()).toBeGreaterThanOrEqual(nextBoundary(boundary, today).getTime());
        });

        it("members-only and age-range programs carry their limits", async () => {
            expect((await byName("Seed: members only")).orgMemberOnly).toBe(true);
            const ages = await byName("Seed: ages 12-17");
            expect([ages.minAge, ages.maxAge]).toEqual([12, 17]);
        });

        it("finished and running programs have participants and attended events", async () => {
            for (const name of ["Seed: finished", "Seed: running now"]) {
                const program = await byName(name);
                expect(program.participants.length).toBeGreaterThan(0);
                const visits = program.events.flatMap((e) => e.visits);
                expect(visits.length).toBeGreaterThan(0);
                expect(visits.every((v) => v.departedAt !== null)).toBe(true);
            }
        });

        it("reseeding creates no duplicates", async () => {
            await seedBaseline(prisma);
            const seeded = await prisma.program.groupBy({
                by: ["name"],
                where: { OR: [{ name: { startsWith: "Seed: " } }, { name: "Woodworking 101" }] },
                _count: true,
            });
            expect(seeded).toHaveLength(10);
            expect(seeded.every((g) => g._count === 1)).toBe(true);
        });
    });

    it("+ Family adds a household with a lead, a partner, and a youth", async () => {
        const before = await prisma.person.count();
        const summary = await createFamily(prisma);
        expect(summary).toMatch(/Test Family/);
        expect(await prisma.person.count()).toBe(before + 3);
        // The created household has exactly one lead.
        const household = await prisma.household.findFirst({
            where: { name: { startsWith: "Test Family" } },
            include: { householdMembers: true },
            orderBy: { id: "desc" },
        });
        expect(household?.householdMembers.filter((m) => m.isHouseholdLead).length).toBe(1);
        expect(household?.householdMembers.length).toBe(3);
    });

    it("+ Program adds a program with two participants", async () => {
        const summary = await createProgram(prisma);
        expect(summary).toMatch(/Test Program/);
        const program = await prisma.program.findFirst({
            where: { name: { startsWith: "Test Program" } },
            include: { participants: true },
            orderBy: { id: "desc" },
        });
        expect(program?.participants.length).toBe(2);
    });

    it("+ Event adds an event with RSVPs", async () => {
        const summary = await createEvent(prisma);
        expect(summary).toMatch(/Test Event/);
        const event = await prisma.event.findFirst({
            where: { name: { startsWith: "Test Event" } },
            include: { rsvps: true },
            orderBy: { id: "desc" },
        });
        expect(event?.rsvps.length).toBe(3);
    });

    it("+ Check-ins adds visits and badge events", async () => {
        const visitsBefore = await prisma.visit.count();
        const summary = await createCheckins(prisma);
        expect(summary).toMatch(/check-ins/);
        expect(await prisma.visit.count()).toBeGreaterThan(visitsBefore);
        expect(await prisma.rawBadgeLog.count()).toBeGreaterThan(0);
    });

    it("reset (truncate + reseed) clears macro data, restores baseline, and preserves the ledger", async () => {
        // A ledger row written before a reset must survive it (it is the cross-tester memory).
        await prisma.devLedger.create({
            data: { action: "login", realActor: "tester@innovationtreehouse.org", detail: "pre-reset" },
        });
        const ledgerBefore = await prisma.devLedger.count();

        await truncateAll();
        await seedBaseline(prisma);

        // Macro fixtures are gone…
        expect(await prisma.program.findFirst({ where: { name: { startsWith: "Test Program" } } })).toBeNull();
        expect(await prisma.household.findFirst({ where: { name: { startsWith: "Test Family" } } })).toBeNull();
        // …baseline is back…
        expect(await prisma.person.findUnique({ where: { email: "boardmember@example.com" } })).not.toBeNull();
        // …and the ledger survived the truncation.
        expect(await prisma.devLedger.count()).toBe(ledgerBefore);

        await prisma.devLedger.deleteMany({ where: { detail: "pre-reset" } });
    });
});
