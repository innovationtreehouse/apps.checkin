/**
 * Steps the Board retries and a sysadmin does not, by `library:step`: those that post to QuickBooks, and
 * replaying a captured email, both finance's work.
 */
const BOARD_ONLY = new Set(["expense:QuickBooks posting", "expense:QuickBooks processing", "gifts:QuickBooks posting", "receipt:mail message"]);

/** Whether this viewer may retry this Problems list item: the Board any step, a sysadmin any step outside BOARD_ONLY. */
export function mayRetry(viewer: { isSysadmin?: boolean; isBoardMember?: boolean } | null | undefined, item: { library: string; step: string }): boolean {
    if (viewer?.isBoardMember === true) return true;
    return viewer?.isSysadmin === true && !BOARD_ONLY.has(`${item.library}:${item.step}`);
}
