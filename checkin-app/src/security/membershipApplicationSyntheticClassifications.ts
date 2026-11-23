/**
 * Non-Prisma response models the Board's Applications tab ships through
 * handler() (the catalogSyntheticClassifications.ts pattern).
 *
 * MembershipApplicationRow — one row of GET /api/membership-ops/applications:
 * the OrgMembershipProcess fields the tab reads, at OrgMembershipProcess's
 * tiers, plus `notRenewing`, true when the row is a renewal for the year its
 * household has said it won't renew into. `notRenewing` is `internal`, the
 * tier of OrgMembership.notRenewingYear it is computed from. No other process
 * field exists here, so a hardship or Shopify field cannot leave whatever the
 * route selects.
 *
 * Every mirrored field's tier is pinned to its schema field's tier by
 * __tests__/membership-application-strip.test.ts.
 *
 * ApplicationSettleCounts — the counts from one run of the waiting-
 * application settle sweep (POST /api/membership-ops/applications/settle-waiting):
 * households swept, check reviews opened, households that failed. All
 * `internal`, and no field names a household or person.
 *
 * Hand-authored, not generated: this describes an API response, not a table.
 * This is a security-boundary artifact — changes ship in a boundary PR.
 */
export const classifications = {
  MembershipApplicationRow: {
    id: "public",
    kind: "public",
    status: "internal",
    createdAt: "public",
    zohoEnvelopeId: "internal",
    contractSignedAt: "internal",
    bgConsentAt: "internal",
    bgClearedAt: "internal",
    paidAt: "internal",
    requestedForHouseholdId: "public",
    notRenewing: "internal",
  },
  ApplicationSettleCounts: {
    households: "internal",
    opened: "internal",
    failed: "internal",
  },
} as const;

export const relations = {
  MembershipApplicationRow: {
    attestations: { model: "BackgroundCheckAttestation", isList: true },
    subjectPerson: { model: "Person", isList: false },
    orgMembership: { model: "OrgMembership", isList: false },
  },
} as const;

// Finance marks: the fields whose presence in a response makes it a logged finance view.
export const marks = {} as const;
