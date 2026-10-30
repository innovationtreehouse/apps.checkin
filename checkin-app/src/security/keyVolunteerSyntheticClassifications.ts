/**
 * Non-Prisma response models the Key Volunteer Agreement routes ship through
 * handler() (the catalogSyntheticClassifications.ts pattern).
 *
 * KeyVolunteerSelfStatus — the caller's own KVA status (GET
 * /api/membership/key-volunteer and POST /api/membership/key-volunteer/sync):
 * whether they owe a signature, the agreement version, whether a signing
 * request has started and whether the document is configured.
 *
 * KeyVolunteerSigning — the embedded sign URL for the caller's own open KVA
 * (POST /api/membership/key-volunteer/sign).
 *
 * KeyVolunteerVersionBump — the Board's version bump (POST
 * /api/settings/membership/key-volunteer-version): the new version and how
 * many agreements it opened. No person leaves.
 *
 * Every field is `internal` except `personId`, the `their_own` binding key in
 * scopeBindings.ts, which is `public` as Person.id is.
 *
 * Hand-authored, not generated: this describes an API response, not a table.
 * This is a security-boundary artifact — changes ship in a boundary PR.
 */
export const classifications = {
  KeyVolunteerSelfStatus: {
    personId: "public",
    owesSignature: "internal",
    agreementVersion: "internal",
    requestStarted: "internal",
    documentConfigured: "internal",
  },
  KeyVolunteerSigning: {
    personId: "public",
    signUrl: "internal",
  },
  KeyVolunteerVersionBump: {
    agreementVersion: "internal",
    agreementsOpened: "internal",
  },
} as const;

export const relations = {} as const;
