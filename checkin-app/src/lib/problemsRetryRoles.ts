/** Steps whose retry posts to QuickBooks, by `library:step`. Only finance acts in QuickBooks, so the Board retries these and a sysadmin does not. */
const BOARD_ONLY = new Set(["expense:QuickBooks posting", "expense:QuickBooks processing", "gifts:QuickBooks posting"]);

/** Whether this viewer may retry this Problems list item: the Board any step, a sysadmin any step that does not post to QuickBooks. */
export function mayRetry(viewer: { isSysadmin?: boolean; isBoardMember?: boolean } | null | undefined, item: { library: string; step: string }): boolean {
    if (viewer?.isBoardMember === true) return true;
    return viewer?.isSysadmin === true && !BOARD_ONLY.has(`${item.library}:${item.step}`);
}
