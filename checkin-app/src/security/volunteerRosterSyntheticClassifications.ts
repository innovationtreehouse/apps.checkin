/**
 * Non-Prisma response models the Board's volunteer roster ships through handler()
 * (the catalogSyntheticClassifications.ts pattern).
 *
 * VolunteerRosterRow — one row of GET /api/membership-ops/volunteer-memberships:
 * a volunteer household, or a designated email with no volunteer membership
 * yet. Each field takes the tier of the column it is built from:
 *   - key, householdId: Household.id / VolunteerDesignation.id (public)
 *   - householdName: Household.name (public)
 *   - leads: the household leads' Person.name (public)
 *   - memberSince: OrgMembership.memberSince (public)
 *   - status: derived from OrgMembershipProcess.status (internal) and
 *     OrgMembership.status, so it carries the stricter of the two
 *   - email: Person.email or VolunteerDesignation.email (pii)
 *
 * VolunteerRosterDesignation — a designation backing a row, tiered as
 * VolunteerDesignation's id, email and createdAt.
 *
 * Hand-authored, not generated: this describes an API response, not a table.
 * This is a security-boundary artifact — changes ship in a boundary PR.
 */
export const classifications = {
  VolunteerRosterRow: {
    key: "public",
    householdId: "public",
    householdName: "public",
    leads: "public",
    memberSince: "public",
    status: "internal",
    email: "pii",
  },
  VolunteerRosterDesignation: {
    id: "public",
    email: "pii",
    createdAt: "public",
  },
} as const;

export const relations = {
  VolunteerRosterRow: {
    designations: { model: "VolunteerRosterDesignation", isList: true },
  },
} as const;

// Finance marks: the fields whose presence in a response makes it a logged finance view.
export const marks = {} as const;
