import type { PrismaClient } from "@/generated/prisma/client";
import { addHouseholdLead } from "@/lib/household/leads";
import { setRoleFlag, type RoleFlag } from "@/lib/roles";
import { mintPersonId } from "@/lib/person/mintId";
import { withTx } from "@/lib/db-client";

/**
 * Dev seed + macro helpers (docs/ops/dev-instance.md, "Macros") — the ONE source of truth for creating
 * dev fixtures. Both `prisma/seed.ts` (the CLI seed + the reset baseline) and the dashboard's
 * one-click macros call into here, so there is no copy-paste drift between them.
 *
 * Every helper takes the Prisma client as a parameter (the CLI passes its own pg-backed client,
 * the app server actions pass the singleton) and is pure of any environment assumptions — the
 * dev-only fencing lives in the callers (assertDevActor). Macros are ADDITIVE: each call creates
 * fresh, uniquely-named rows so testers can stack scenarios; only the reset is destructive.
 */

// Structural subset of PrismaClient — enough for these helpers, accepts both client flavors.
type Db = PrismaClient;

/** Short unique tag so stacked macro calls never collide on unique columns (e.g. email). */
function uid(): string {
    return Date.now().toString(36).slice(-5) + Math.floor(Math.random() * 1296).toString(36);
}

function yearsAgo(years: number): Date {
    const d = new Date();
    d.setFullYear(d.getFullYear() - years);
    return d;
}

// System bypass: dev seed fixtures are the trusted source of their own grants — there is
// no requesting user's authority to check, so this always passes a system actor (the
// last-board-member guard still applies inside setRoleFlag; only the matrix is skipped).
async function seedRole(prisma: Db, personId: number, flag: RoleFlag): Promise<void> {
    await setRoleFlag(prisma, personId, flag, true, { system: "system:dev-seed" });
}

// ──────────────────────────────────────────────────────────────────────────
// Baseline — the standard 9 debug personas + tools + a sample program. Idempotent
// (upserts), so it is safe to run on a fresh DB or after a reset. This is the body that
// used to live in prisma/seed.ts main().
// ──────────────────────────────────────────────────────────────────────────
export async function seedBaseline(prisma: Db): Promise<void> {
    console.log("🌱 Seeding database with debug personas...\n");

    // 1. Households (participants require one, so these come first)
    let household1 = await prisma.household.findFirst({ where: { name: "Family" } });
    if (!household1) {
        household1 = await prisma.household.create({
            data: { name: "Family", line1: "123 Maker Lane" },
        });
    }

    let household2 = await prisma.household.findFirst({ where: { name: "Family2" } });
    if (!household2) {
        household2 = await prisma.household.create({
            data: { name: "Family2", line1: "456 Workshop Drive" },
        });
    }

    // A third non-member household. Family and Family2 are each already claimed by
    // a membership flow test as their applicant; this one keeps the intake-notes
    // flow test's applicant disjoint on the shared serial DB.
    let household3 = await prisma.household.findFirst({ where: { name: "Family3" } });
    if (!household3) {
        household3 = await prisma.household.create({
            data: { name: "Family3", line1: "789 Volunteer Way" },
        });
    }

    // 2. The 9 debug personas (solo personas get a single-person household of their own)
    const isBoardMember = await prisma.person.upsert({
        where: { email: "boardmember@example.com" },
        update: { name: "Board Member", phone: "555-555-0001", isSysadmin: true, isBoardMember: true, isDeclaredAdult: true },
        create: {
            email: "boardmember@example.com",
            name: "Board Member",
            phone: "555-555-0001",
            isSysadmin: true,
            isBoardMember: true,
            isDeclaredAdult: true,
            household: { create: { name: "Board Member Household" } },
        },
    });
    // PersonRole is the source of truth the claims/lock now read — every non-PATCH
    // board/role writer (seeds included) must populate the table, not just the mirror.
    await seedRole(prisma, isBoardMember.id, "isSysadmin");
    await seedRole(prisma, isBoardMember.id, "isBoardMember");

    const parentFamily = await prisma.person.upsert({
        where: { email: "parent.family@example.com" },
        update: { name: "Parent Family", phone: "555-555-0002" },
        create: {
            email: "parent.family@example.com",
            name: "Parent Family",
            phone: "555-555-0002",
            householdId: household1.id,
        },
    });

    const parent2Family = await prisma.person.upsert({
        where: { email: "parent2.family@example.com" },
        update: { name: "Parent2 Family", phone: "555-555-0003" },
        create: {
            email: "parent2.family@example.com",
            name: "Parent2 Family",
            phone: "555-555-0003",
            householdId: household1.id,
        },
    });

    const childFamily = await prisma.person.upsert({
        where: { email: "child.family@example.com" },
        update: { name: "Child Family", dateOfBirth: yearsAgo(10) },
        create: {
            email: "child.family@example.com",
            name: "Child Family",
            dateOfBirth: yearsAgo(10),
            householdId: household1.id,
        },
    });

    const parentFamily2 = await prisma.person.upsert({
        where: { email: "parent.family2@example.com" },
        update: { name: "Parent Family2", phone: "555-555-0004" },
        create: {
            email: "parent.family2@example.com",
            name: "Parent Family2",
            phone: "555-555-0004",
            householdId: household2.id,
        },
    });

    const parentFamily3 = await prisma.person.upsert({
        where: { email: "parent.family3@example.com" },
        update: { name: "Parent Family3", phone: "555-555-0010" },
        create: {
            email: "parent.family3@example.com",
            name: "Parent Family3",
            phone: "555-555-0010",
            householdId: household3.id,
        },
    });

    const keyholder1 = await prisma.person.upsert({
        where: { email: "keyholder1@example.com" },
        update: { name: "Keyholder One", phone: "555-555-0005", isKeyholder: true },
        create: {
            email: "keyholder1@example.com",
            name: "Keyholder One",
            phone: "555-555-0005",
            isKeyholder: true,
            household: { create: { name: "Keyholder One Household" } },
        },
    });
    await seedRole(prisma, keyholder1.id, "isKeyholder");

    const keyholder2 = await prisma.person.upsert({
        where: { email: "keyholder2@example.com" },
        update: { name: "Keyholder Two", phone: "555-555-0006", isKeyholder: true },
        create: {
            email: "keyholder2@example.com",
            name: "Keyholder Two",
            phone: "555-555-0006",
            isKeyholder: true,
            household: { create: { name: "Keyholder Two Household" } },
        },
    });
    await seedRole(prisma, keyholder2.id, "isKeyholder");

    const certifiedAdult = await prisma.person.upsert({
        where: { email: "certified.adult@example.com" },
        update: { name: "Certified Adult", phone: "555-555-0007" },
        create: {
            email: "certified.adult@example.com",
            name: "Certified Adult",
            phone: "555-555-0007",
            household: { create: { name: "Certified Adult Household" } },
        },
    });

    // No carte-blanche "may certify others" role exists. This persona is a plain
    // member who holds the MAY_CERTIFY_OTHERS certification on a single tool (granted
    // below), exercising the per-tool certifier path.
    const toolCertifier = await prisma.person.upsert({
        where: { email: "tool.certifier@example.com" },
        update: { name: "Tool Certifier", phone: "555-555-0008" },
        create: {
            email: "tool.certifier@example.com",
            name: "Tool Certifier",
            phone: "555-555-0008",
            household: { create: { name: "Tool Certifier Household", orgMembership: { create: { status: "ACTIVE" } } } },
        },
    });
    await addHouseholdLead(prisma, toolCertifier.householdId, toolCertifier.id);

    const bgReviewer = await prisma.person.upsert({
        where: { email: "bg.reviewer@example.com" },
        update: { name: "BG Reviewer", phone: "555-555-0009", isBackgroundCheckReviewer: true },
        create: {
            email: "bg.reviewer@example.com",
            name: "BG Reviewer",
            phone: "555-555-0009",
            isBackgroundCheckReviewer: true,
            household: { create: { name: "BG Reviewer Household" } },
        },
    });
    await seedRole(prisma, bgReviewer.id, "isBackgroundCheckReviewer");

    // Global catalog manager (#1286). INVENTORY_MANAGER is PersonRole-table-only
    // (no mirror column, like isOperations), so the grant is seedRole, not a
    // create field. Curates the catalog in flow tests; also a catalog viewer.
    const inventoryManager = await prisma.person.upsert({
        where: { email: "inventory.manager@example.com" },
        update: { name: "Inventory Manager", phone: "555-555-0012", isDeclaredAdult: true },
        create: {
            email: "inventory.manager@example.com",
            name: "Inventory Manager",
            phone: "555-555-0012",
            isDeclaredAdult: true,
            household: { create: { name: "Inventory Manager Household" } },
        },
    });
    await seedRole(prisma, inventoryManager.id, "isInventoryManager");

    // A member household lead used by program-pricing flow tests: an ACTIVE
    // OrgMembership so member pricing/discount-code paths have a claimable persona.
    const memberPricingLead = await prisma.person.upsert({
        where: { email: "member.pricing@example.com" },
        update: { name: "Member Pricing Lead", phone: "555-555-0011", dateOfBirth: yearsAgo(40) },
        create: {
            email: "member.pricing@example.com",
            name: "Member Pricing Lead",
            phone: "555-555-0011",
            dateOfBirth: yearsAgo(40),
            household: { create: { name: "Member Pricing Family" } },
        },
    });

    // 3. Household assignments & leads
    await prisma.person.update({ where: { id: parentFamily.id }, data: { householdId: household1.id } });
    await prisma.person.update({ where: { id: parent2Family.id }, data: { householdId: household1.id } });
    await prisma.person.update({ where: { id: childFamily.id }, data: { householdId: household1.id } });

    await addHouseholdLead(prisma, household1.id, parentFamily.id);

    await prisma.person.update({ where: { id: parentFamily2.id }, data: { householdId: household2.id } });
    await addHouseholdLead(prisma, household2.id, parentFamily2.id);

    await prisma.person.update({ where: { id: parentFamily3.id }, data: { householdId: household3.id } });
    await addHouseholdLead(prisma, household3.id, parentFamily3.id);

    await addHouseholdLead(prisma, memberPricingLead.householdId, memberPricingLead.id);
    await prisma.orgMembership.upsert({
        where: { householdId: memberPricingLead.householdId },
        update: { status: "ACTIVE" },
        create: { householdId: memberPricingLead.householdId, status: "ACTIVE" },
    });

    // 4. Tools & certifications
    const tableSaw = await prisma.tool.upsert({
        where: { id: 1 },
        update: { name: "Table Saw" },
        create: { name: "Table Saw", safetyGuide: "https://example.com/table-saw-safety" },
    });
    const drillPress = await prisma.tool.upsert({
        where: { id: 2 },
        update: { name: "Drill Press" },
        create: { name: "Drill Press", safetyGuide: "https://example.com/drill-press-safety" },
    });
    await prisma.toolStatus.upsert({
        where: { personId_toolId: { personId: certifiedAdult.id, toolId: tableSaw.id } },
        update: { level: "CERTIFIED" },
        create: { personId: certifiedAdult.id, toolId: tableSaw.id, level: "CERTIFIED" },
    });
    await prisma.toolStatus.upsert({
        where: { personId_toolId: { personId: certifiedAdult.id, toolId: drillPress.id } },
        update: { level: "CERTIFIED" },
        create: { personId: certifiedAdult.id, toolId: drillPress.id, level: "CERTIFIED" },
    });
    await prisma.toolStatus.upsert({
        where: { personId_toolId: { personId: toolCertifier.id, toolId: tableSaw.id } },
        update: { level: "MAY_CERTIFY_OTHERS" },
        create: { personId: toolCertifier.id, toolId: tableSaw.id, level: "MAY_CERTIFY_OTHERS" },
    });

    // 5. Sample program
    const program = await prisma.program.findFirst({ where: { name: "Woodworking 101" } });
    if (!program) {
        await prisma.program.create({
            data: {
                name: "Woodworking 101",
                leadMentorId: isBoardMember.id,
                startAt: new Date(),
                endAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
                phase: "UPCOMING",
                enrollmentStatus: "OPEN",
                orgMemberOnly: false,
                minAge: 8,
                maxParticipants: 20,
            },
        });
    }

    console.log("🎉 Seed complete — 9 debug personas, tools, and a sample program are ready.");
}

// ──────────────────────────────────────────────────────────────────────────
// Macros — additive one-click scenario seeders (each returns a one-line summary for a toast).
// ──────────────────────────────────────────────────────────────────────────

/** + Family — a household with a lead adult, a partner, and a youth. */
export async function createFamily(prisma: Db): Promise<string> {
    const tag = uid();
    const household = await prisma.household.create({
        data: { name: `Test Family ${tag}`, line1: `${tag} Maker Way` },
    });
    await prisma.orgMembership.create({
        data: { householdId: household.id, status: "ACTIVE" },
    });
    // The + Family macro is click-repeatable, so it is the unbounded seed site —
    // it mints like production. (The fixed persona upserts below stay on the
    // sequence; see personIdMintGuard.test.ts.)
    const lead = await withTx(prisma, async (tx) =>
        tx.person.create({
            data: {
                id: await mintPersonId(tx),
                name: `Lead ${tag}`,
                email: `lead.${tag}@example.com`,
                phone: "555-100-0000",
                dateOfBirth: yearsAgo(38),
                householdId: household.id,
            },
        }),
    );
    await addHouseholdLead(prisma, household.id, lead.id);
    await withTx(prisma, async (tx) =>
        tx.person.create({
            data: {
                id: await mintPersonId(tx),
                name: `Partner ${tag}`,
                email: `partner.${tag}@example.com`,
                dateOfBirth: yearsAgo(36),
                householdId: household.id,
            },
        }),
    );
    await withTx(prisma, async (tx) =>
        tx.person.create({
            data: { id: await mintPersonId(tx), name: `Kid ${tag}`, dateOfBirth: yearsAgo(9), householdId: household.id },
        }),
    );
    return `Created household "Test Family ${tag}" (lead + partner + 1 youth)`;
}

/** + Program — a program with a couple of active participants. */
export async function createProgram(prisma: Db): Promise<string> {
    const tag = uid();
    const startAt = new Date();
    const endAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    const program = await prisma.program.create({
        data: {
            name: `Test Program ${tag}`,
            startAt,
            endAt,
            phase: "UPCOMING",
            enrollmentStatus: "OPEN",
            minAge: 8,
            maxParticipants: 20,
        },
    });
    const enrollees = await prisma.person.findMany({ take: 2, orderBy: { id: "asc" } });
    for (const p of enrollees) {
        await prisma.programParticipant.create({
            data: { programId: program.id, personId: p.id, status: "ACTIVE" },
        });
    }
    return `Created program "Test Program ${tag}" with ${enrollees.length} participants`;
}

/** + Event — an event (tied to the latest program when one exists) with a few RSVPs. */
export async function createEvent(prisma: Db): Promise<string> {
    const tag = uid();
    const latestProgram = await prisma.program.findFirst({ orderBy: { id: "desc" } });
    const startAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const endAt = new Date(startAt.getTime() + 2 * 60 * 60 * 1000);
    const event = await prisma.event.create({
        data: {
            name: `Test Event ${tag}`,
            programId: latestProgram?.id ?? null,
            startAt,
            endAt,
            description: "Auto-generated dev event",
        },
    });
    const attendees = await prisma.person.findMany({ take: 3, orderBy: { id: "asc" } });
    for (const p of attendees) {
        await prisma.rSVP.create({
            data: { eventId: event.id, personId: p.id, status: "ATTENDING" },
        });
    }
    const where = latestProgram ? ` under program #${latestProgram.id}` : "";
    return `Created event "Test Event ${tag}"${where} with ${attendees.length} RSVPs`;
}

/** + Check-ins — recent visits + badge events so attendance screens have data. */
export async function createCheckins(prisma: Db): Promise<string> {
    const people = await prisma.person.findMany({ take: 5, orderBy: { id: "asc" } });
    let count = 0;
    for (const [i, p] of people.entries()) {
        const arrived = new Date(Date.now() - (i + 1) * 45 * 60 * 1000); // staggered into the past
        await prisma.rawBadgeLog.create({
            data: { personId: p.id, timestamp: arrived, location: "Front Door" },
        });
        await prisma.visit.create({
            data: {
                personId: p.id,
                arrivedAt: arrived,
                // Leave the most recent two still "here" (no departure) for active-visit screens.
                departedAt: i < 2 ? null : new Date(arrived.getTime() + 90 * 60 * 1000),
            },
        });
        count++;
    }
    return count > 0
        ? `Created ${count} check-ins (visits + badge events)`
        : "No participants to check in — seed the baseline first";
}
