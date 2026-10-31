import { PrismaClient } from "../src/generated/prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { canonicalizeEmail } from "../src/lib/emailNormalize";

/**
 * MONEY-PATH SAFETY GATE for the volunteer-designation email match.
 *
 * applyVolunteerFamilyStatus (src/lib/membership/review.ts) sets Membership.isVolunteerFamily
 * when a household lead's email matches a VolunteerDesignation — and isVolunteerFamily
 * DRIVES THE MEMBERSHIP FEE. That match uses canonicalizeEmail (Gmail-only dot-drop, strip +tag).
 * oldNormalize (strip dots on EVERY domain, keep +tag) produces a different match set.
 *
 * This script recomputes the designation-match result for every household under
 * BOTH rules against the live DB and prints every household whose volunteer match
 * RESULT differs (gained or lost). Empty diff = the rules agree on this data.
 * Non-empty = human review required.
 *
 * NOTE: only the designation-match path is modeled. The markedByReviewer path
 * (isVolunteerFamily already true) is unaffected by normalization and out of scope.
 *
 *   npx tsx scripts/membership-fee-diff-volunteer-match.ts
 *
 * Bootstraps Prisma exactly like prisma/seed.ts (PrismaPg adapter, DATABASE_URL).
 */

/** Strips dots on every domain and keeps +tag. Only this script carries this rule. */
function oldNormalize(email: string): string {
    const lower = email.trim().toLowerCase();
    const at = lower.indexOf("@");
    if (at < 0) return lower;
    return lower.slice(0, at).replace(/\./g, "") + lower.slice(at);
}

async function main() {
    const pool = new Pool({ connectionString: `${process.env.DATABASE_URL}` });
    const adapter = new PrismaPg(pool);
    const prisma = new PrismaClient({ adapter });

    try {
        const designations = (await prisma.volunteerDesignation.findMany({ select: { email: true } })).map((d) => d.email);

        // Household leads with an email — mirrors applyVolunteerFamilyStatus's parent query:
        // a person flagged isHouseholdLead leads their own household.
        const leads = await prisma.person.findMany({
            where: { isHouseholdLead: true },
            select: { householdId: true, email: true },
        });

        // Group parent emails by household (non-null email).
        const byHousehold = new Map<number, string[]>();
        for (const l of leads) {
            const email = l.email;
            if (!email) continue;
            const list = byHousehold.get(l.householdId) ?? [];
            list.push(email);
            byHousehold.set(l.householdId, list);
        }

        const matches = (parentEmails: string[], norm: (e: string) => string): boolean => {
            const parents = new Set(parentEmails.map(norm));
            return designations.some((d) => parents.has(norm(d)));
        };

        const changed: { householdId: number; old: boolean; now: boolean; parentEmails: string[] }[] = [];
        for (const [householdId, parentEmails] of byHousehold) {
            const oldMatch = matches(parentEmails, oldNormalize);
            const newMatch = matches(parentEmails, canonicalizeEmail);
            if (oldMatch !== newMatch) changed.push({ householdId, old: oldMatch, now: newMatch, parentEmails });
        }

        console.log(`Designations: ${designations.length}`);
        console.log(`Households with lead email(s): ${byHousehold.size}`);
        console.log(`Households whose volunteer-match RESULT changes: ${changed.length}`);
        if (changed.length === 0) {
            console.log("\n✅ EMPTY DIFF — normalization flip is match-equivalent on this data. Safe.");
        } else {
            console.log("\n⚠️  NON-EMPTY DIFF — HUMAN REVIEW REQUIRED. Affected households (isVolunteerFamily drives the membership fee):\n");
            for (const c of changed) {
                const verb = c.now ? "GAINS volunteer status" : "LOSES volunteer status";
                console.log(`  household ${c.householdId}: ${verb} (old=${c.old} new=${c.now}) leads=[${c.parentEmails.join(", ")}]`);
            }
        }
    } finally {
        await pool.end();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
