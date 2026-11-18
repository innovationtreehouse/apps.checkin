import { config, isVerifiedOrgAccount } from '@/lib/config';

/**
 * The rule for whether a session user counts as signed in: a positive integer id, no
 * denied household, and no open household question (only its own route takes that
 * session, through `allowJoinPending`). Prisma drops a `where` key whose value is
 * undefined, so an id-less session filtering by its own id would match every row.
 * On the deployed dev instance the session must also be a verified org account, because
 * its Google OAuth client admits any Google account. The staging gate is separate
 * (`isStagingAccessAllowed`) because it also applies to non-session callers.
 */
export function isAcceptedSession(
    user: { id?: unknown; denied?: boolean; householdJoinPending?: boolean; hd?: string | null; emailVerified?: boolean },
    opts?: { allowJoinPending?: boolean },
): boolean {
    const { id } = user;
    return typeof id === 'number' && Number.isInteger(id) && id > 0 && !user.denied
        && (!user.householdJoinPending || opts?.allowJoinPending === true)
        && (!config.isDeployedDev() || isVerifiedOrgAccount(user));
}
