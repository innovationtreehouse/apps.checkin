/**
 * Non-Prisma response model the background-check "started" family path ships
 * through handler() (the catalogSyntheticClassifications.ts pattern).
 *
 * CheckStartedRow — one row of GET and POST /api/membership/check-started: an
 * adult the caller may mark as having started their check. `state` is
 * NEEDS_MARKING or NOTHING_TO_DO and nothing finer, so a household lead never
 * learns another adult's clearance, review or decisions from it.
 *
 * `personId` is the their_own / led_households binding key in scopeBindings.ts
 * and `name` mirrors Person.name; both are `public` as on Person. `state` is
 * `internal`, reached only through those two scopes.
 *
 * Hand-authored, not generated: this describes an API response, not a table.
 * This is a security-boundary artifact — changes ship in a boundary PR.
 */
export const classifications = {
  CheckStartedRow: {
    personId: "public",
    name: "public",
    state: "internal",
  },
} as const;

export const relations = {} as const;

// Finance marks: the fields whose presence in a response makes it a logged finance view.
export const marks = {} as const;
