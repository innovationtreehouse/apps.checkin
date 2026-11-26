/**
 * Non-Prisma response models the membership audit lists and the caller's own
 * membership reads ship through handler() (the catalogSyntheticClassifications.ts
 * pattern). They keep each route's wire shape and list only the fields that
 * leave.
 *
 * HouseholdContactPerson — a person the board or front desk reaches about a
 * household: id and name at Person's `public`, phone and email at Person's
 * `pii`. A row carries only the fields its route selects.
 *
 * MissingContactHousehold — GET /api/membership-audit/households-missing-contact:
 * a household with no valid emergency contact, Household's id and name, and its
 * `leads`.
 *
 * UnclaimedHousehold — GET /api/membership-audit/unclaimed-households: a
 * household no lead has claimed, or one with no lead, Household's id and name
 * (or a member's name standing in for it), and its `members` with an email.
 *
 * MembershipPaymentLink — GET /api/membership/payment: the fee the household
 * pays (`amountCents`, one of BoardSettings' `public` fee columns), the finance
 * contact address (BoardSettings' `public` financeContactEmail), and the
 * Shopify `checkoutUrl`, `internal` because it embeds the volunteer-family
 * discount code, BoardSettings' `internal` volunteerFamilyDiscountCode.
 *
 * RenewalStatus — GET /api/membership/renewal-status: whether the caller's
 * household has a renewal awaiting confirmation (`renewalDue`, read from
 * OrgMembershipProcess' `internal` status), its due date (`dueDate`, from the
 * `public` year boundary and process createdAt), and whether the household
 * said it won't renew (`notRenewing`, from OrgMembership's `internal`
 * notRenewingYear).
 *
 * None of these models is row-scoped: the views that read them grant
 * `everyones` tokens, and the two membership reads answer only about the
 * caller's own household.
 *
 * Hand-authored, not generated: this describes an API response, not a table.
 * This is a security-boundary artifact — changes ship in a boundary PR.
 */
export const classifications = {
  HouseholdContactPerson: {
    id: "public",
    name: "public",
    phone: "pii",
    email: "pii",
  },
  MissingContactHousehold: {
    id: "public",
    name: "public",
  },
  UnclaimedHousehold: {
    id: "public",
    name: "public",
  },
  MembershipPaymentLink: {
    amountCents: "public",
    checkoutUrl: "internal",
    financeContactEmail: "public",
  },
  RenewalStatus: {
    renewalDue: "internal",
    dueDate: "public",
    notRenewing: "internal",
  },
} as const;

export const relations = {
  MissingContactHousehold: {
    leads: { model: "HouseholdContactPerson", isList: true },
  },
  UnclaimedHousehold: {
    members: { model: "HouseholdContactPerson", isList: true },
  },
} as const;

// Finance marks: the fields whose presence in a response makes it a logged finance view.
export const marks = {} as const;
