/**
 * Non-Prisma response model the Roles screen ships through handler()
 * (the catalogSyntheticClassifications.ts pattern).
 *
 * RoleHolder — one person on GET /api/roles (`people`) and the person PATCH
 * /api/roles returns (`user`). Each field takes the tier of the column it is
 * built from:
 *   - id, email, name, canAccessStaging: Person's own tiers
 *   - isSysadmin, isBoardMember, isKeyholder, isBackgroundCheckReviewer:
 *     the Person flag column each mirrors
 *   - isOperations, isInventoryManager, isFinance, isKeyVolunteer: derived
 *     from PersonRole.role alone (no Person column), so `internal`
 *   - isYouth: derived from Person.dateOfBirth, so `personal`
 *   - kvaSignedCurrent, kvaSignedAt, kvaOpenProcessId: the person's Key
 *     Volunteer Agreement standing, built from OrgMembershipProcess status,
 *     agreementVersion and contractSignedAt, so `internal`
 *
 * Hand-authored, not generated: this describes an API response, not a table.
 * This is a security-boundary artifact — changes ship in a boundary PR.
 */
export const classifications = {
  RoleHolder: {
    id: "public",
    email: "pii",
    name: "public",
    canAccessStaging: "internal",
    isSysadmin: "internal",
    isBoardMember: "public",
    isKeyholder: "internal",
    isBackgroundCheckReviewer: "internal",
    isOperations: "internal",
    isInventoryManager: "internal",
    isFinance: "internal",
    isKeyVolunteer: "internal",
    isYouth: "personal",
    kvaSignedCurrent: "internal",
    kvaSignedAt: "internal",
    kvaOpenProcessId: "internal",
  },
} as const;

export const relations = {} as const;

// Finance marks: the fields whose presence in a response makes it a logged finance view.
export const marks = {} as const;
