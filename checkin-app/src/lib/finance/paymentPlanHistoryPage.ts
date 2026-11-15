export const PAST_PAGE_SIZE = 25;

/** The query keys the Past routes read, in the order the finance-view log records them. */
export const PAST_QUERY_KEYS = { page: "page", archived: "archived" } as const;

/** The zero-based page a `?page=` parameter asks for; anything else is the first page. */
export function pageParam(req: Request): number {
    const page = Number.parseInt(new URL(req.url).searchParams.get(PAST_QUERY_KEYS.page) ?? "", 10);
    return Number.isInteger(page) && page > 0 ? page : 0;
}

/** Whether `?archived=1` asks to include decisions for archived households; they are hidden otherwise. */
export function archivedParam(req: Request): boolean {
    return new URL(req.url).searchParams.get(PAST_QUERY_KEYS.archived) === "1";
}
