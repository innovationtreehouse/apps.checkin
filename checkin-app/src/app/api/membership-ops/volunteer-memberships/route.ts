import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { LIVE_PERSON } from "@/lib/person/filters";
import { canonicalizeEmail } from "@/lib/emailNormalize";
import { IN_FLIGHT_INITIAL, IN_FLIGHT_RENEWAL, type ProcessStatus } from "@/lib/membership/lifecycle";
import type { OrgMembershipStatus } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

/**
 * One volunteer roster row. Rows are HOUSEHOLD-grained because `isVolunteer`
 * lives on OrgMembership (one per household) — volunteer status is a property of
 * the family's membership fee, not of a person.
 */
export type VolunteerRowStatus =
    /** Volunteer membership, ACTIVE. */
    | "VOLUNTEER"
    /** Volunteer household part-way through intake or renewal. */
    | "IN_PROGRESS"
    /** Volunteer household whose application a BG reviewer rejected — board-actionable. */
    | "BLOCKED"
    /** Volunteer household with no live application left (archived or abandoned). */
    | "INACTIVE"
    /** Designated email with no volunteer membership yet. */
    | "DESIGNATED"
    /** Designated email whose household holds an ACTIVE full-price membership; the designation only bites at renewal. */
    | "NEXT_RENEWAL"
    /** Volunteer membership the board revoked or denied. */
    | "REVOKED";

/** A VolunteerDesignation backing a roster row. One Remove action per entry. */
export interface VolunteerRowDesignation {
    id: number;
    email: string;
    createdAt: string;
}

export interface VolunteerRow {
    key: string;
    status: VolunteerRowStatus;
    householdId: number | null;
    householdName: string | null;
    leads: string[];
    email: string | null;
    memberSince: string | null;
    /** Every designation resolving to this row — a household can hold several (both parents). */
    designations: VolunteerRowDesignation[];
}

const IN_FLIGHT = [...new Set([...IN_FLIGHT_INITIAL, ...IN_FLIGHT_RENEWAL])];

/**
 * Processes that still say something about a household's standing. BLOCKED sits
 * outside the IN_FLIGHT sets on purpose — those mirror the partial unique
 * indexes (lifecycle.ts) — but a blocked application is live and board-
 * actionable, so it is loaded here and ranked separately below.
 */
const LIVE_PROCESS: ProcessStatus[] = [...IN_FLIGHT, "BLOCKED"];

const LIVE_PROCESS_SELECT = { where: { status: { in: LIVE_PROCESS } }, select: { status: true } } as const;

/** A live application's contribution to the row status; null when there is none. */
const processStatus = (processes: { status: ProcessStatus }[]) =>
    processes.some((p) => p.status === "BLOCKED") ? "BLOCKED" : processes.length > 0 ? "IN_PROGRESS" : null;

/**
 * Membership and designation rows share this: a board decision outranks anything
 * a designation implies. DENIED blocks the household's login outright, so
 * "Pre-designated" would tell the board a family is queued up that cannot sign in.
 */
const isRevoked = (status: OrgMembershipStatus | undefined) => status === "REVOKED" || status === "DENIED";

/** GET — the volunteer roster: current volunteer households + pre-designated emails. */
export const GET = withAuth({ roles: ["isSysadmin", "isBoardMember"] }, async () => {
    const [memberships, designations] = await Promise.all([
        prisma.orgMembership.findMany({
            where: { isVolunteer: true },
            select: {
                status: true,
                memberSince: true,
                household: {
                    select: {
                        id: true,
                        name: true,
                        householdMembers: {
                            where: { isHouseholdLead: true, ...LIVE_PERSON },
                            select: { name: true, email: true },
                            orderBy: { id: "asc" },
                        },
                    },
                },
                processes: LIVE_PROCESS_SELECT,
            },
        }),
        prisma.volunteerDesignation.findMany({ orderBy: { createdAt: "desc" } }),
    ]);

    // Resolve designated emails through the SAME rule that grants the fee —
    // canonicalizeEmail against HOUSEHOLD LEADS (review.ts applyVolunteerStatus).
    // Matching any looser (case-only, or any household member) would show a
    // standing the engine will never produce.
    //
    // ponytail: O(n) scan over leads with an email, no indexed normalized column
    // — same tradeoff as api/webhooks/resend, fine at this org's scale.
    const wanted = new Set(designations.map((d) => canonicalizeEmail(d.email)));
    const leads = wanted.size
        ? await prisma.person.findMany({
              where: { email: { not: null }, isHouseholdLead: true, ...LIVE_PERSON },
              select: {
                  email: true,
                  household: {
                      select: {
                          id: true,
                          name: true,
                          orgMembership: {
                              select: {
                                  status: true,
                                  memberSince: true,
                                  processes: LIVE_PROCESS_SELECT,
                              },
                          },
                          householdMembers: {
                              where: { isHouseholdLead: true, ...LIVE_PERSON },
                              select: { name: true },
                              orderBy: { id: "asc" },
                          },
                      },
                  },
              },
          })
        : [];

    const householdByEmail = new Map<string, (typeof leads)[number]["household"]>();
    for (const p of leads) {
        const key = canonicalizeEmail(p.email!);
        if (wanted.has(key) && !householdByEmail.has(key)) householdByEmail.set(key, p.household);
    }

    const rows: VolunteerRow[] = memberships.map((m) => ({
        key: `hh:${m.household.id}`,
        status:
            m.status === "ACTIVE"
                ? "VOLUNTEER"
                : isRevoked(m.status)
                  ? "REVOKED"
                  : (processStatus(m.processes) ?? "INACTIVE"),
        householdId: m.household.id,
        householdName: m.household.name,
        leads: m.household.householdMembers.map((p) => p.name ?? "Unnamed"),
        email: m.household.householdMembers.find((p) => p.email)?.email ?? null,
        memberSince: m.status === "ACTIVE" ? m.memberSince.toISOString() : null,
        designations: [],
    }));

    const rowByHousehold = new Map(rows.map((r) => [r.householdId, r]));

    for (const d of designations) {
        const ref = { id: d.id, email: d.email, createdAt: d.createdAt.toISOString() };
        const household = householdByEmail.get(canonicalizeEmail(d.email)) ?? null;
        // Already on the roster — hang the designation off that row (so every one
        // of a household's designations keeps its own Remove) rather than
        // duplicating the household.
        const existing = household ? rowByHousehold.get(household.id) : undefined;
        if (existing) {
            existing.designations.push(ref);
            continue;
        }
        const membership = household?.orgMembership ?? null;
        const row: VolunteerRow = {
            key: `des:${d.id}`,
            status:
                membership?.status === "ACTIVE"
                    ? "NEXT_RENEWAL"
                    : isRevoked(membership?.status)
                      ? "REVOKED"
                      : ((membership && processStatus(membership.processes)) ?? "DESIGNATED"),
            householdId: household?.id ?? null,
            householdName: household?.name ?? null,
            leads: household?.householdMembers.map((p) => p.name ?? "Unnamed") ?? [],
            email: d.email,
            memberSince: membership?.status === "ACTIVE" ? membership.memberSince.toISOString() : null,
            designations: [ref],
        };
        rows.push(row);
        if (household) rowByHousehold.set(household.id, row);
    }

    return NextResponse.json({ rows });
});
