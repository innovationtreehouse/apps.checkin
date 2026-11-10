export const PAST_PAGE_SIZE = 25;

/** The zero-based page a `?page=` parameter asks for; anything else is the first page. */
export function pageParam(req: Request): number {
    const page = Number.parseInt(new URL(req.url).searchParams.get("page") ?? "", 10);
    return Number.isInteger(page) && page > 0 ? page : 0;
}
