/**
 * Non-Prisma response models GET and PATCH /api/household ship through
 * handler() (the catalogSyntheticClassifications.ts pattern). They keep the
 * my-household response shape while listing only the fields that leave.
 *
 * HouseholdPage — the GET response: `boardReplyTo` (the org's reply-to
 * address, `member`), `validUntil` (the household's membership valid-through
 * date, `public` like OrgMembership.status) and the caller's `household`.
 *
 * HouseholdPageHousehold — that household: Household's id, name and address,
 * at Household's tiers, with its members and its org membership.
 *
 * HouseholdPeer — one member of the caller's household: the peer projection
 * (lib/household/participantProjection.ts) at Person's tiers, plus `householdId`
 * (the scope key) and `emailLocked`, the boolean computed from the email-lock
 * inputs, which are `internal` and so is it. No other Person field exists here,
 * so a role flag or a background-check date cannot leave whatever the route selects.
 *
 * HouseholdPeerBgStatus — a peer's `bgStatus`: whether their background check
 * is valid, expires before the upcoming membership year, or has expired,
 * computed on the server so no clearance date leaves. `personId` is the
 * their_own / led_households binding key in scopeBindings.ts; `status` is
 * `internal` and reaches only the person themself and a lead of their
 * household, never a non-lead sibling.
 *
 * HouseholdMemberAdded / EmergencyContactWarning — the PATCH response: the new
 * `member` and the emergency-contact `warning` raised when that member is
 * already one of the household's emergency contacts. The warning's contact
 * details are `personal`, the EmergencyContact band.
 *
 * Every mirrored field's tier is pinned to its schema field's tier by
 * __tests__/household-route-strip.test.ts.
 *
 * Hand-authored, not generated: this describes an API response, not a table.
 * This is a security-boundary artifact — changes ship in a boundary PR.
 */
export const classifications = {
  HouseholdPage: {
    boardReplyTo: "member",
    validUntil: "public",
  },
  HouseholdPageHousehold: {
    id: "public",
    name: "public",
    line1: "internal",
    line2: "internal",
    city: "internal",
    state: "internal",
    postalCode: "internal",
  },
  HouseholdPeer: {
    id: "public",
    householdId: "public",
    name: "public",
    nickname: "public",
    email: "pii",
    phone: "pii",
    dateOfBirth: "personal",
    isDeclaredAdult: "internal",
    allergies: "personal",
    isHouseholdLead: "public",
    emailLocked: "internal",
  },
  HouseholdPeerBgStatus: {
    personId: "public",
    status: "internal",
  },
  HouseholdMemberAdded: {},
  EmergencyContactWarning: {
    code: "public",
    householdId: "public",
    conflictedContactIds: "personal",
    hasValidContact: "personal",
    message: "personal",
  },
} as const;

export const relations = {
  HouseholdPage: {
    household: { model: "HouseholdPageHousehold", isList: false },
  },
  HouseholdPageHousehold: {
    householdMembers: { model: "HouseholdPeer", isList: true },
    orgMembership: { model: "OrgMembership", isList: false },
  },
  HouseholdPeer: {
    bgStatus: { model: "HouseholdPeerBgStatus", isList: false },
  },
  HouseholdMemberAdded: {
    member: { model: "HouseholdPeer", isList: false },
    warning: { model: "EmergencyContactWarning", isList: false },
  },
} as const;

// Finance marks: the fields whose presence in a response makes it a logged finance view.
export const marks = {} as const;
