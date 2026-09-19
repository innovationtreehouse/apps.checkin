import prisma from "@/lib/prisma";
import { LIVE_PERSON } from "@/lib/person/filters";
import { membershipYearCycle, MAX_DATE } from "@/lib/membership/renewal";
import { IN_FLIGHT_RENEWAL, IN_FLIGHT_INITIAL, settledThisCycleWhere } from "@/lib/membership/lifecycle";
import { personRecordIsActiveOrgMember } from "@/lib/orgMembership";
import type { OrgMembershipProcessStatus } from "@/generated/prisma/client";

export type Audience = "a" | "b" | "c";
export type OutreachVariant = "join" | "renew";
export type ItemStatus = "queued" | "skipped_unsubscribed";

export interface RecipientSnapshotItem {
    personId: number;
    email: string;
    variant: OutreachVariant;
    status: ItemStatus;
}

export interface RecipientSnapshot {
    items: RecipientSnapshotItem[];
    /** isHouseholdLead && LIVE_PERSON && email == null, in the chosen audience's base
     * population — informational only, these leads get no item. */
    leadsWithoutEmail: number;
}

const IN_FLIGHT_STATUSES = new Set<OrgMembershipProcessStatus>([...IN_FLIGHT_RENEWAL, ...IN_FLIGHT_INITIAL]);

/** Compute the recipient snapshot for one audience preset (see spec §2.2). One query for the
 * candidate leads (with just enough of their household's membership to decide settled/
 * in-flight/variant in JS — no per-row N+1), one query for the without-email count. */
export async function computeRecipientSnapshot(audience: Audience, now = new Date()): Promise<RecipientSnapshot> {
    // "Settled" = bought the live membership year (settledThisCycleWhere, the same test
    // membershipValidThrough and households-ops use), so a renewed household is left
    // alone after the boundary too. No boundary ⇒ nobody is settled.
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 }, select: { orgMembershipYearBoundary: true } });
    const cycle = settings?.orgMembershipYearBoundary ? membershipYearCycle(settings.orgMembershipYearBoundary, now) : null;
    const settledSince = cycle?.settledSince ?? MAX_DATE;

    const [leadsWithoutEmail, leads] = await Promise.all([
        prisma.person.count({ where: { isHouseholdLead: true, email: null, ...LIVE_PERSON } }),
        prisma.person.findMany({
            where: { isHouseholdLead: true, email: { not: null }, ...LIVE_PERSON },
            select: {
                id: true,
                email: true,
                emailSuppressed: true,
                household: {
                    select: {
                        orgMembership: {
                            select: {
                                status: true,
                                // Only the processes relevant to settled/in-flight decisions —
                                // computed ONCE per snapshot, not re-queried per household.
                                processes: {
                                    where: {
                                        OR: [
                                            settledThisCycleWhere(settledSince),
                                            { status: { in: [...IN_FLIGHT_STATUSES] } },
                                        ],
                                    },
                                    select: { status: true },
                                },
                            },
                        },
                    },
                },
            },
        }),
    ]);

    const byEmail = new Map<string, { personId: number; email: string; variant: OutreachVariant; emailSuppressed: boolean }>();

    for (const lead of leads) {
        if (!lead.email) continue; // narrows for TS; the where already excludes this
        const membership = lead.household.orgMembership;
        const isMember = membership?.status === "ACTIVE";

        if (audience !== "c") {
            // Rows here are either settled-shape or in-flight; a paid-pending row is
            // both, and reads as in-flight (a nudge mid-renewal is not wrong).
            const settled = (membership?.processes ?? []).some((p) => p.status === "ACTIVE");
            if (isMember && settled) continue; // excluded from both (a) and (b)

            if (audience === "b") {
                const inFlight = (membership?.processes ?? []).some((p) => IN_FLIGHT_STATUSES.has(p.status));
                if (inFlight) continue;
            }
        }

        const variant: OutreachVariant = personRecordIsActiveOrgMember({ household: { orgMembership: membership ?? null } })
            ? "renew"
            : "join";

        const key = lead.email.toLowerCase();
        const existing = byEmail.get(key);
        // Dedup by lowercased email (mirrors resolveHouseholdRecipients, emailRecipients.ts:31-38).
        // Person.email is @unique + auto-lowercased at write (prismaEmailNormalize.ts), so two
        // DISTINCT Person rows can't actually collide here today — this is defense-in-depth
        // matching that precedent, not a reachable case against the current schema. If any
        // duplicate resolves to a member, the renew variant wins for the merged item.
        if (!existing || (variant === "renew" && existing.variant !== "renew")) {
            byEmail.set(key, { personId: lead.id, email: lead.email, variant, emailSuppressed: lead.emailSuppressed });
        }
    }

    const items: RecipientSnapshotItem[] = [...byEmail.values()].map((r) => ({
        personId: r.personId,
        email: r.email,
        variant: r.variant,
        // Suppression is join-variant-only (binding decision, spec §2.4): renew recipients
        // are never dropped, and a suppressed join recipient is recorded (not silently
        // dropped) so the count/ledger stays honest.
        status: r.variant === "join" && r.emailSuppressed ? "skipped_unsubscribed" : "queued",
    }));

    return { items, leadsWithoutEmail };
}
