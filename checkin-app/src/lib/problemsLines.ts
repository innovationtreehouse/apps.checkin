/** The Problems line for a source whose read failed: the library's stuck items, or the failed-email count. */
export const unreadLine = (library: string): string =>
    library === "email" ? "Failed email sends could not be counted." : `Could not read the stuck items in ${library}.`;
