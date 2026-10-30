/**
 * The rule for whether a session user counts as signed in: a positive integer id and
 * no denied household. Prisma drops a `where` key whose value is undefined, so an
 * id-less session filtering by its own id would match every row. The staging gate is
 * separate (`isStagingAccessAllowed`) because it also applies to non-session callers.
 */
export function isAcceptedSession(user: { id?: unknown; denied?: boolean }): boolean {
    const { id } = user;
    return typeof id === 'number' && Number.isInteger(id) && id > 0 && !user.denied;
}
