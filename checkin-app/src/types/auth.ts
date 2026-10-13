import type { Session } from 'next-auth';

/**
 * The NextAuth session user. The shape is declared once, by the module
 * augmentation in `types/next-auth.d.ts`; this alias is the name the app
 * imports so no consumer hand-copies a subset that can drift.
 *
 * Every role flag is OPTIONAL here, matching the session shape — check with
 * `=== true`, never `!user.isSysadmin` as a proof of anything.
 */
export type SessionUser = NonNullable<Session['user']>;

/**
 * Business role field names from the Person model.
 * Used by withAuth() to check roles directly via user[role] === true.
 */
export type BusinessRole = 'isSysadmin' | 'isBoardMember' | 'isKeyholder' | 'isBackgroundCheckReviewer' | 'isOperations';

/** Session role flags a client nav or page gate may check: the business roles plus FINANCE. */
export type NavRole = BusinessRole | 'isFinance';

/**
 * A session user as resolved by the auth boundary (`lib/auth.ts`
 * authenticateRequest) — narrower than `SessionUser` on two points that
 * authorization code depends on, both guaranteed by `assignParticipantClaims`:
 * the five role flags are always stamped as real booleans, and `householdId`
 * is a plain Int (`Person.householdId` is non-null in the schema), never null.
 *
 * Derived, not hand-copied, so it tracks the `next-auth.d.ts` augmentation.
 */
export type AuthenticatedUser = SessionUser &
    Required<Pick<SessionUser, BusinessRole>> & { householdId?: number };

/**
 * Result of authenticating a request — either kiosk, session, or unauthenticated.
 */
export type AuthResult =
    | { type: 'kiosk' }
    | { type: 'session'; user: AuthenticatedUser }
    | { type: 'unauthenticated' };
